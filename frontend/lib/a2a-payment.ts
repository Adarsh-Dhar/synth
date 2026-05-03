import crypto from "node:crypto";
import { prisma } from "@/lib/prisma";

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

export class A2APaymentService {
  static async assertEnterprise(ownerId: string) {
    const user = await prisma.user.findUnique({
      where: { id: ownerId },
      select: { plan: true, planExpiresAt: true },
    });

    const isEnterprise = String(user?.plan || "free").toLowerCase() === "enterprise";
    const isActive = !user?.planExpiresAt || user.planExpiresAt.getTime() > Date.now();

    if (!isEnterprise || !isActive) {
      throw Object.assign(new Error("ENTERPRISE_REQUIRED"), { status: 403 });
    }
  }

  static async createWallet(agentId: string, ownerId: string, pubkey: string) {
    await this.assertEnterprise(ownerId);

    return prisma.botWallet.upsert({
      where: { agentId },
      create: { agentId, ownerId, pubkey },
      update: { ownerId, pubkey, updatedAt: new Date() },
    });
  }

  static async enablePrivatePayments(agentId: string, ownerId: string) {
    await this.assertEnterprise(ownerId);

    const rawKey = `ppa_${crypto.randomBytes(24).toString("hex")}`;
    const keyHash = crypto.createHash("sha256").update(rawKey).digest("hex");

    const wallet = await prisma.botWallet.findUnique({ where: { agentId } });
    if (!wallet) {
      throw new Error("Wallet is not configured for this agent.");
    }
    if (wallet.ownerId !== ownerId) {
      throw new Error("Wallet ownership mismatch.");
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

  static getWallet(agentId: string, ownerId: string) {
    return prisma.botWallet.findFirst({ where: { agentId, ownerId } });
  }

  static async registerService(agentId: string, ownerId: string, opts: ServiceOpts) {
    await this.assertEnterprise(ownerId);

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

  static async setServiceStatus(serviceId: string, status: "online" | "offline" | "degraded") {
    return prisma.botService.update({
      where: { id: serviceId },
      data: { status, lastHeartbeat: new Date(), updatedAt: new Date() },
    });
  }

  static listPublicServices(serviceType?: string) {
    return prisma.botService.findMany({
      where: {
        isPublic: true,
        status: "online",
        ...(serviceType ? { serviceType } : {}),
      },
    });
  }

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
      await this.assertEnterprise(payer.userId);
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
      },
    });
  }

  static async activateChannel(channelId: string, channelAccountPubkey: string, openTxSig: string) {
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

  static async pay(
    channelId: string,
    payerAgentId: string,
    payeeAgentId: string,
    amountMicro: number,
    currency: string,
    purpose: string,
    idempotencyKey: string
  ) {
    const channel = await prisma.a2APaymentChannel.findUniqueOrThrow({ where: { id: channelId } });
    if (channel.status !== "open") throw new Error("Channel is not open.");
    if (amountMicro > channel.maxPerTxMicro) throw new Error("Payment exceeds per-tx cap.");

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

    return prisma.a2APayment.create({
      data: {
        channelId,
        payerAgentId,
        payeeAgentId,
        amountMicro,
        currency,
        purpose,
        idempotencyKey,
        status: "pending",
      },
    });
  }

  static async confirmPayment(paymentId: string, txSig: string, slot: number) {
    await prisma.a2APayment.update({
      where: { id: paymentId },
      data: { status: "confirmed", txSignature: txSig, slot, confirmedAt: new Date() },
    });

    const payment = await prisma.a2APayment.findUniqueOrThrow({ where: { id: paymentId } });
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

  static async closeChannel(channelId: string, closeTxSig: string) {
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

  static async addToWhitelist(serviceId: string, allowedAgentId: string, grantedBy: string) {
    return prisma.botServiceWhitelist.upsert({
      where: { serviceId_allowedAgentId: { serviceId, allowedAgentId } },
      create: { serviceId, allowedAgentId, grantedBy },
      update: {},
    });
  }
}