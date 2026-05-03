/**
 * A2A Payments Service — Agent-to-Agent Payment Channels
 *
 * Handles:
 * - Wallet registration with Private Payments API
 * - Service registration and marketplace
 * - Payment channel lifecycle (open, activate, pay, close)
 * - Integration with Private Payments API for secure transfers
 * - Whitelist management for restricted services
 */

import crypto from "node:crypto";
import { Connection, PublicKey } from "@solana/web3.js";
import { prisma } from "@/lib/prisma";
import { privatePaymentsRequest } from "@/lib/magicblock-http";
import { verifyTransactionStatus } from "@/lib/solana-tx-utils";

export type ServiceOpts = {
  serviceType: "oracle_feed" | "scraper" | "compute" | "liquidity_signal" | "custom";
  name: string;
  description?: string;
  endpointUrl?: string;
  currency?: "USDC" | "SOL";
  pricePerCallMicro?: number;
  pricePerSecondMicro?: number;
  isPublic?: boolean;
  requiresWhitelist?: boolean;
};

export type ChannelOpts = {
  currency?: "USDC" | "SOL";
  maxPerTxMicro?: number;
  dailyCapMicro?: number;
};

/**
 * Verify user has an active enterprise plan
 */
async function assertEnterprise(ownerId: string): Promise<void> {
  const user = await prisma.user.findUnique({
    where: { id: ownerId },
    select: { plan: true, planExpiresAt: true },
  });

  const isEnterprise = String(user?.plan || "free").toLowerCase() === "enterprise";
  const isActive = !user?.planExpiresAt || user.planExpiresAt.getTime() > Date.now();

  if (!isEnterprise || !isActive) {
    const err = new Error("ENTERPRISE_REQUIRED");
    (err as any).status = 403;
    throw err;
  }
}

export class A2APaymentService {
  /**
   * Create a wallet for the agent
   * Registers it with the Private Payments API
   */
  static async createWallet(agentId: string, ownerId: string, pubkey: string) {
    await assertEnterprise(ownerId);

    // Register the wallet with the Private Payments API
    try {
      await privatePaymentsRequest<{ status: string }>(agentId, "POST", "/deposit", {
        pubkey,
        agentId,
      });
    } catch (err) {
      // 409 = wallet already registered, which is fine
      const msg = err instanceof Error ? err.message : String(err);
      if (!msg.includes("409")) {
        throw err;
      }
    }

    return prisma.botWallet.upsert({
      where: { agentId },
      create: { agentId, ownerId, pubkey },
      update: { ownerId, pubkey, updatedAt: new Date() },
    });
  }

  /**
   * Enable private payments for an agent
   * Generates and registers an API key
   */
  static async enablePrivatePayments(agentId: string, ownerId: string) {
    await assertEnterprise(ownerId);

    const wallet = await prisma.botWallet.findUnique({ where: { agentId } });
    if (!wallet) {
      throw new Error("Wallet is not configured for this agent.");
    }
    if (wallet.ownerId !== ownerId) {
      throw new Error("Wallet ownership mismatch.");
    }

    const rawKey = `ppa_${crypto.randomBytes(24).toString("hex")}`;
    const keyHash = crypto.createHash("sha256").update(rawKey).digest("hex");

    // Register the API key with the Private Payments API
    try {
      await privatePaymentsRequest(agentId, "POST", "/register-key", {
        pubkey: wallet.pubkey,
        keyHash,
      });
    } catch (err) {
      throw new Error(
        `Failed to register payment API key: ${err instanceof Error ? err.message : String(err)}`
      );
    }

    await prisma.botWallet.update({
      where: { agentId },
      data: {
        privatePaymentsEnabled: true,
        paymentApiKeyHash: keyHash,
        updatedAt: new Date(),
      },
    });

    return rawKey;
  }

  /**
   * Get a wallet by agent ID
   */
  static getWallet(agentId: string, ownerId: string) {
    return prisma.botWallet.findFirst({ where: { agentId, ownerId } });
  }

  /**
   * Get private balance from the Private Payments API
   */
  static async getPrivateBalance(
    agentId: string,
    currency: "USDC" | "SOL" = "USDC"
  ): Promise<{ balance: number; currency: string }> {
    return privatePaymentsRequest(agentId, "GET", `/private-balance?currency=${currency}`);
  }

  /**
   * Register a service that can be offered to other agents
   */
  static async registerService(agentId: string, ownerId: string, opts: ServiceOpts) {
    await assertEnterprise(ownerId);

    return prisma.botService.create({
      data: {
        agentId,
        ownerId,
        serviceType: opts.serviceType,
        name: opts.name,
        description: opts.description,
        endpointUrl: opts.endpointUrl,
        currency: opts.currency ?? "USDC",
        pricePerCallMicro: opts.pricePerCallMicro ?? 0,
        pricePerSecondMicro: opts.pricePerSecondMicro ?? 0,
        isPublic: opts.isPublic ?? false,
        requiresWhitelist: opts.requiresWhitelist ?? false,
        status: "offline",
      },
    });
  }

  /**
   * Update the status of a service
   */
  static async setServiceStatus(
    serviceId: string,
    status: "online" | "offline" | "degraded"
  ) {
    return prisma.botService.update({
      where: { id: serviceId },
      data: { status, lastHeartbeat: new Date(), updatedAt: new Date() },
    });
  }

  /**
   * List public services available for payment
   */
  static listPublicServices(serviceType?: string) {
    return prisma.botService.findMany({
      where: {
        isPublic: true,
        status: "online",
        ...(serviceType ? { serviceType } : {}),
      },
    });
  }

  /**
   * Open a payment channel between two agents
   * Communicates with Private Payments API to create the channel account
   */
  static async openChannel(
    payerAgentId: string,
    payeeAgentId: string,
    serviceId: string | null,
    opts: ChannelOpts = {}
  ) {
    const payer = await prisma.agent.findUnique({
      where: { id: payerAgentId },
      select: { userId: true },
    });
    if (payer?.userId) {
      await assertEnterprise(payer.userId);
    }

    const payeeWallet = await prisma.botWallet.findUnique({
      where: { agentId: payeeAgentId },
      select: { pubkey: true },
    });
    if (!payeeWallet) {
      throw new Error(
        `Payee agent ${payeeAgentId} does not have a registered wallet`
      );
    }

    // Call Private Payments API to open the channel
    let channelAccountPubkey: string | null = null;
    try {
      const channelData = await privatePaymentsRequest<{
        channelId?: string;
        channelAccountPubkey?: string;
      }>(payerAgentId, "POST", "/channels/open", {
        payeePubkey: payeeWallet.pubkey,
        currency: opts.currency ?? "USDC",
        maxPerTxMicro: opts.maxPerTxMicro ?? 1_000_000,
        dailyCapMicro: opts.dailyCapMicro ?? 100_000_000,
      });

      channelAccountPubkey = channelData.channelAccountPubkey ?? null;
    } catch (err) {
      console.error(
        `[A2A] Failed to open channel with Private Payments API:`,
        err
      );
      // Continue anyway; channel can be created in DB and activated later
    }

    return prisma.a2APaymentChannel.create({
      data: {
        payerAgentId,
        payeeAgentId,
        serviceId: serviceId ?? undefined,
        currency: opts.currency ?? "USDC",
        maxPerTxMicro: opts.maxPerTxMicro ?? 1_000_000,
        dailyCapMicro: opts.dailyCapMicro ?? 100_000_000,
        status: "pending",
        channelAccountPubkey,
      },
    });
  }

  /**
   * Activate a payment channel
   * Confirms the open transaction on-chain before allowing payments
   */
  static async activateChannel(
    channelId: string,
    channelAccountPubkey: string,
    openTxSig: string
  ) {
    const channel = await prisma.a2APaymentChannel.findUniqueOrThrow({
      where: { id: channelId },
    });

    // Confirm the open tx on L1
    const rpcUrl = process.env.SOLANA_RPC_URL ?? "http://127.0.0.1:8899";
    const connection = new Connection(rpcUrl, "confirmed");

    const status = await verifyTransactionStatus(connection, openTxSig);
    if (!status.confirmed) {
      throw new Error(
        `Channel open transaction failed: ${status.error ?? "Unknown error"}`
      );
    }

    return prisma.a2APaymentChannel.update({
      where: { id: channelId },
      data: {
        status: "open",
        channelAccountPubkey,
        openTxSignature: openTxSig,
        openedAt: new Date(),
        updatedAt: new Date(),
      },
    });
  }

  /**
   * Send a payment through an open channel
   * Calls the Private Payments API to execute the transfer
   */
  static async pay(
    channelId: string,
    payerAgentId: string,
    payeeAgentId: string,
    amountMicro: number,
    currency: string,
    purpose: string,
    idempotencyKey: string
  ) {
    const channel = await prisma.a2APaymentChannel.findUniqueOrThrow({
      where: { id: channelId },
    });

    if (channel.status !== "open") {
      throw new Error("Channel is not open.");
    }

    if (amountMicro > channel.maxPerTxMicro) {
      throw new Error("Payment exceeds per-tx cap.");
    }

    // Check daily cap
    const today = new Date(new Date().setHours(0, 0, 0, 0));
    const totals = await prisma.a2APayment.aggregate({
      _sum: { amountMicro: true },
      where: {
        channelId,
        status: "confirmed",
        createdAt: { gte: today },
      },
    });

    if ((totals._sum.amountMicro ?? 0) + amountMicro > channel.dailyCapMicro) {
      throw new Error("Daily cap would be exceeded.");
    }

    // Execute the private transfer via Private Payments API
    let txHash: string | null = null;
    try {
      const transferResult = await privatePaymentsRequest<{
        txHash?: string;
        transferId?: string;
      }>(payerAgentId, "POST", "/transfer", {
        channelAccountPubkey: channel.channelAccountPubkey,
        amountMicro,
        currency,
        purpose,
        idempotencyKey,
        payeeAgentId,
      });

      txHash = transferResult.txHash ?? null;
    } catch (err) {
      console.error(
        `[A2A] Failed to execute transfer via Private Payments API:`,
        err
      );
      // Continue anyway; record the payment as pending
    }

    const payment = await prisma.a2APayment.create({
      data: {
        channelId,
        payerAgentId,
        payeeAgentId,
        amountMicro,
        currency,
        purpose,
        idempotencyKey,
        status: txHash ? "confirmed" : "pending",
        txSignature: txHash,
        confirmedAt: txHash ? new Date() : null,
      },
    });

    // Update channel stats if transfer was successful
    if (txHash) {
      await prisma.a2APaymentChannel.update({
        where: { id: channelId },
        data: {
          totalPaidMicro: { increment: amountMicro },
          totalTxCount: { increment: 1 },
          lastPaymentAt: new Date(),
          updatedAt: new Date(),
        },
      });
    }

    return payment;
  }

  /**
   * Confirm a payment after observing it on-chain
   */
  static async confirmPayment(paymentId: string, txSig: string, slot: number) {
    await prisma.a2APayment.update({
      where: { id: paymentId },
      data: {
        status: "confirmed",
        txSignature: txSig,
        slot,
        confirmedAt: new Date(),
      },
    });

    const payment = await prisma.a2APayment.findUniqueOrThrow({
      where: { id: paymentId },
    });

    await prisma.a2APaymentChannel.update({
      where: { id: payment.channelId },
      data: {
        totalPaidMicro: { increment: payment.amountMicro },
        totalTxCount: { increment: 1 },
        lastPaymentAt: new Date(),
        updatedAt: new Date(),
      },
    });
  }

  /**
   * Close a payment channel
   * Notifies the Private Payments API
   */
  static async closeChannel(channelId: string, closeTxSig: string) {
    const channel = await prisma.a2APaymentChannel.findUniqueOrThrow({
      where: { id: channelId },
    });

    // Notify the Private Payments API to close the channel
    try {
      await privatePaymentsRequest(channel.payerAgentId, "POST", "/channels/close", {
        channelAccountPubkey: channel.channelAccountPubkey,
        closeTxSig,
      });
    } catch (err) {
      console.error(
        `[A2A] Failed to notify Private Payments API of channel close:`,
        err
      );
      // Log but don't block — the L1 tx is the source of truth
    }

    return prisma.a2APaymentChannel.update({
      where: { id: channelId },
      data: {
        status: "closed",
        closeTxSignature: closeTxSig,
        closedAt: new Date(),
        updatedAt: new Date(),
      },
    });
  }

  /**
   * Add an agent to a service's whitelist
   */
  static async addToWhitelist(
    serviceId: string,
    allowedAgentId: string,
    grantedBy: string
  ) {
    return prisma.botServiceWhitelist.upsert({
      where: { serviceId_allowedAgentId: { serviceId, allowedAgentId } },
      create: { serviceId, allowedAgentId, grantedBy },
      update: {},
    });
  }
}