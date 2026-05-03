/**
 * Shielded Execution Service — TEE Transaction Execution & Settlement
 *
 * Handles:
 * - Enabling/disabling shielded execution configuration
 * - Accepting pre-signed delegation transactions
 * - Submitting instructions to the TEE RPC (not L1)
 * - Committing state and settling back to L1
 */

import { Connection, PublicKey } from "@solana/web3.js";
import { prisma } from "@/lib/prisma";
import {
  getValidatorEndpoint,
  getValidatorPubkey,
  isValidValidator,
} from "@/lib/validators-config";
import {
  submitAndConfirmTx,
  verifyAccountOwner,
  getSlot,
  getAccountInfo,
} from "@/lib/solana-tx-utils";
import { getValidatorAuthToken } from "@/lib/magicblock-http";

// Delegation program address
const DELEGATION_PROGRAM_ID = new PublicKey(
  "DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMARRSaeSh"
);

export type ShieldedOpts = {
  validator?: string;
  shieldStrategyLogic?: boolean;
  shieldIntent?: boolean;
  shieldIntermediateStates?: boolean;
  settlementMode?: "net_only" | "batch_compressed" | "full";
  settlementIntervalMs?: number;
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

/**
 * Verify TEE RPC endpoint is responsive
 */
async function verifyTeeRpcIntegrity(endpoint: string): Promise<void> {
  try {
    const conn = new Connection(endpoint, { commitment: "confirmed" });
    const slot = await getSlot(conn);
    if (slot <= 0) throw new Error("Invalid slot returned from TEE RPC");
  } catch (err) {
    throw new Error(
      `TEE RPC integrity check failed for ${endpoint}: ${err instanceof Error ? err.message : String(err)}`
    );
  }
}

/**
 * Submit a transaction to the TEE RPC
 * Requires authentication via token
 */
async function submitTxToTee(
  validatorEndpoint: string,
  authToken: string,
  rawTxBase64: string
): Promise<string> {
  const txBytes = Buffer.from(rawTxBase64, "base64");

  const conn = new Connection(validatorEndpoint, {
    commitment: "confirmed",
    httpHeaders: { Authorization: `Bearer ${authToken}` },
  });

  const sig = await conn.sendRawTransaction(txBytes, {
    skipPreflight: true,
    preflightCommitment: "confirmed",
  });

  await conn.confirmTransaction(sig, "confirmed");
  return sig;
}

export class ShieldedExecutionService {
  /**
   * Enable shielded execution for an agent
   * Verifies TEE RPC integrity before storing configuration
   */
  static async enable(agentId: string, ownerId: string, opts: ShieldedOpts = {}) {
    await assertEnterprise(ownerId);

    const validator = opts.validator ?? "devnet-tee.magicblock.app";

    // Validate validator exists
    if (!isValidValidator(validator)) {
      throw new Error(`Unknown validator: ${validator}`);
    }

    const validatorPubkey = getValidatorPubkey(validator);
    const endpoint = getValidatorEndpoint(validator);

    // Verify TEE RPC is reachable and responding
    await verifyTeeRpcIntegrity(endpoint);

    return prisma.$transaction(async (tx) => {
      const config = await tx.shieldedExecutionConfig.upsert({
        where: { agentId },
        create: {
          agentId,
          ownerId,
          enabled: true,
          perValidator: validator,
          perValidatorPubkey: validatorPubkey,
          shieldStrategyLogic: opts.shieldStrategyLogic ?? true,
          shieldIntent: opts.shieldIntent ?? true,
          shieldIntermediateStates: opts.shieldIntermediateStates ?? true,
          settlementMode: opts.settlementMode ?? "net_only",
          settlementIntervalMs: opts.settlementIntervalMs ?? 0,
          status: "inactive",
        },
        update: {
          enabled: true,
          perValidator: validator,
          perValidatorPubkey: validatorPubkey,
          shieldStrategyLogic: opts.shieldStrategyLogic ?? true,
          shieldIntent: opts.shieldIntent ?? true,
          shieldIntermediateStates: opts.shieldIntermediateStates ?? true,
          settlementMode: opts.settlementMode ?? "net_only",
          settlementIntervalMs: opts.settlementIntervalMs ?? 0,
          status: "inactive",
          updatedAt: new Date(),
        },
      });

      await tx.shieldedExecutionAudit.create({
        data: {
          configId: config.id,
          agentId,
          actorId: ownerId,
          action: "enable",
          newStatus: "inactive",
          metadata: { validator, validatorPubkey, endpoint },
        },
      });

      return config;
    });
  }

  /**
   * Delegate accounts to the TEE
   * Accepts pre-signed delegation transaction, confirms it on L1,
   * then verifies the logic account is properly delegated
   */
  static async delegate(
    agentId: string,
    ownerId: string,
    logicAccountPubkey: string,
    stateAccountPubkey: string,
    permissionAccountPubkey: string,
    signedTx: string
  ) {
    const config = await prisma.shieldedExecutionConfig.findUnique({
      where: { agentId },
    });

    if (!config || !config.enabled) {
      throw new Error("Shielded Execution is not enabled for this agent.");
    }

    const rpcUrl = process.env.SOLANA_RPC_URL ?? "http://127.0.0.1:8899";
    const connection = new Connection(rpcUrl, "confirmed");

    // Submit the delegation transaction to L1
    const txBytes = Buffer.from(signedTx, "base64");
    const txSig = await submitAndConfirmTx(connection, signedTx, 3);

    // Verify the logic account is now owned by the delegation program
    const logicInfo = await getAccountInfo(connection, new PublicKey(logicAccountPubkey));
    if (
      logicInfo &&
      logicInfo.owner.toBase58() !== DELEGATION_PROGRAM_ID.toBase58()
    ) {
      throw new Error(
        `Logic account is not owned by the delegation program after delegation. Got: ${logicInfo.owner.toBase58()}`
      );
    }

    return prisma.$transaction(async (tx) => {
      const updated = await tx.shieldedExecutionConfig.update({
        where: { agentId },
        data: {
          status: "active",
          logicAccountPubkey,
          stateAccountPubkey,
          permissionAccountPubkey,
          delegationTxSignature: txSig,
          updatedAt: new Date(),
        },
      });

      await tx.shieldedExecutionAudit.create({
        data: {
          configId: config.id,
          agentId,
          actorId: ownerId,
          action: "delegate",
          previousStatus: config.status,
          newStatus: "active",
          metadata: {
            logicAccountPubkey,
            stateAccountPubkey,
            permissionAccountPubkey,
            txSig,
          },
        },
      });

      return updated;
    });
  }

  /**
   * Execute an instruction against the TEE
   * This is called by the worker or orchestrator, not typically by API routes
   */
  static async executeShielded(
    agentId: string,
    rawInstructionTxBase64: string
  ): Promise<string> {
    const config = await prisma.shieldedExecutionConfig.findUnique({
      where: { agentId },
    });

    if (!config || !config.enabled || config.status !== "active") {
      throw new Error("Shielded execution is not active for this agent.");
    }

    const endpoint = getValidatorEndpoint(config.perValidator);

    // Verify TEE RPC is still responsive
    await verifyTeeRpcIntegrity(endpoint);

    // Get auth token for this validator
    const token = await getValidatorAuthToken(endpoint);

    // Submit the transaction to the TEE
    const txSig = await submitTxToTee(endpoint, token, rawInstructionTxBase64);

    // Update shielded operation counter
    await prisma.shieldedExecutionConfig.update({
      where: { agentId },
      data: {
        totalShieldedOps: { increment: 1n },
        updatedAt: new Date(),
      },
    });

    return txSig;
  }

  /**
   * Commit state and settle back to L1
   * This involves a CommitAndUndelegatePermissionCpiBuilder transaction
   */
  static async commitAndSettle(agentId: string, signedSettlementTx: string): Promise<string> {
    const config = await prisma.shieldedExecutionConfig.findUnique({
      where: { agentId },
    });

    if (!config || !config.enabled) {
      throw new Error("Shielded Execution is not configured for this agent.");
    }

    const endpoint = getValidatorEndpoint(config.perValidator);

    // Get auth token for TEE validator
    const token = await getValidatorAuthToken(endpoint);

    // The settlement tx includes CommitAndUndelegatePermissionCpiBuilder instructions
    // These execute inside the TEE and then settle to L1 atomically
    const txSig = await submitTxToTee(endpoint, token, signedSettlementTx);

    // Record the settlement
    await this.recordSettlement(agentId);

    return txSig;
  }

  /**
   * Record that a settlement occurred
   */
  static async recordSettlement(agentId: string): Promise<void> {
    await prisma.shieldedExecutionConfig.update({
      where: { agentId },
      data: {
        totalSettledTxs: { increment: 1 },
        lastSettlementAt: new Date(),
        updatedAt: new Date(),
      },
    });
  }

  /**
   * Disable shielded execution for an agent
   */
  static async disable(agentId: string, ownerId: string) {
    const config = await prisma.shieldedExecutionConfig.findUnique({
      where: { agentId },
    });

    if (!config) {
      throw new Error("Shielded Execution is not configured for this agent.");
    }

    return prisma.$transaction(async (tx) => {
      const updated = await tx.shieldedExecutionConfig.update({
        where: { agentId },
        data: {
          enabled: false,
          status: "inactive",
          updatedAt: new Date(),
        },
      });

      await tx.shieldedExecutionAudit.create({
        data: {
          configId: config.id,
          agentId,
          actorId: ownerId,
          action: "disable",
          previousStatus: config.status,
          newStatus: "inactive",
          metadata: { wasActive: config.status === "active" },
        },
      });

      return updated;
    });
  }

  /**
   * Get the configuration for an agent's shielded execution
   */
  static getConfig(agentId: string, ownerId: string) {
    return prisma.shieldedExecutionConfig.findFirst({
      where: { agentId, ownerId },
      include: {
        audits: { orderBy: { createdAt: "desc" }, take: 10 },
      },
    });
  }
}