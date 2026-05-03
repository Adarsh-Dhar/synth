/**
 * Private Brain Service — TEE Delegation & Encrypted State Management
 *
 * Handles:
 * - Enabling/disabling private brain configuration
 * - Accepting pre-signed delegation transactions from clients
 * - Confirming delegation on-chain
 * - Reading encrypted state from the TEE RPC
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

// Delegation program address
const DELEGATION_PROGRAM_ID = new PublicKey(
  "DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMARRSaeSh"
);

export type PrivateBrainOpts = {
  validator?: string;
  memorySlots?: number;
  geofenceRegions?: string[];
};

/**
 * Derive the bot's state PDA using agent ID
 */
function deriveStatePda(agentId: string, programId: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("bot_state"), Buffer.from(agentId)],
    programId
  );
}

/**
 * Derive the permission account PDA
 */
function derivePermissionPda(
  stateAccount: PublicKey,
  owner: PublicKey,
  programId: PublicKey
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("permission"), stateAccount.toBytes(), owner.toBytes()],
    programId
  );
}

/**
 * Normalize geofence regions
 */
function normalizeGeofenceRegions(regions?: string[]): string[] {
  return Array.isArray(regions)
    ? regions.map((region) => String(region).trim()).filter(Boolean)
    : [];
}

/**
 * Verify user has an active enterprise plan
 */
async function assertEnterprise(ownerId: string) {
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
 * Verify TEE validator is reachable and responsive
 */
async function verifyValidatorHealth(endpoint: string): Promise<void> {
  try {
    const conn = new Connection(endpoint, { commitment: "confirmed" });
    const slot = await getSlot(conn);
    if (slot <= 0) throw new Error("Invalid slot returned from validator");
  } catch (err) {
    throw new Error(
      `TEE validator at ${endpoint} is unreachable: ${err instanceof Error ? err.message : String(err)}`
    );
  }
}

/**
 * Submit and confirm a pre-signed delegation transaction on L1
 */
async function submitAndConfirmDelegationTx(
  connection: Connection,
  rawTxBase64: string
): Promise<string> {
  const txSig = await submitAndConfirmTx(connection, rawTxBase64, 3);
  return txSig;
}

/**
 * Verify that the state account is owned by the delegation program after delegation
 */
async function verifyAccountDelegated(
  connection: Connection,
  stateAccount: PublicKey
): Promise<void> {
  const info = await getAccountInfo(connection, stateAccount);
  if (!info) {
    throw new Error(
      `State account ${stateAccount.toBase58()} not found on-chain after delegation`
    );
  }

  if (info.owner.toBase58() !== DELEGATION_PROGRAM_ID.toBase58()) {
    throw new Error(
      `Account is not owned by the delegation program. Got: ${info.owner.toBase58()}`
    );
  }
}

/**
 * Schedule an undelegation job for the worker to process
 */
async function scheduleUndelegation(
  agentId: string,
  ownerId: string,
  stateAccountPubkey: string,
  validator: string
): Promise<void> {
  const config = await prisma.privateBrainConfig.findUnique({
    where: { agentId },
  });

  if (!config) return;

  await prisma.privateBrainAudit.create({
    data: {
      configId: config.id,
      agentId,
      actorId: ownerId,
      action: "undelegate_scheduled",
      previousStatus: config.status,
      newStatus: "undelegating",
      metadata: { stateAccountPubkey, validator },
    },
  }).catch((err) => {
    console.error(
      `[PrivateBrain] Failed to schedule undelegation for agent ${agentId}:`,
      err
    );
  });
}

export class PrivateBrainService {
  /**
   * Enable private brain for an agent
   * Verifies the TEE validator is reachable before storing configuration
   */
  static async enable(agentId: string, ownerId: string, opts: PrivateBrainOpts = {}) {
    await assertEnterprise(ownerId);

    const validator = opts.validator ?? "devnet-tee.magicblock.app";

    // Validate validator exists
    if (!isValidValidator(validator)) {
      throw new Error(`Unknown validator: ${validator}`);
    }

    const validatorPubkey = getValidatorPubkey(validator);
    const endpoint = getValidatorEndpoint(validator);

    // Verify the TEE validator is live before storing config
    await verifyValidatorHealth(endpoint);

    return prisma.$transaction(async (tx) => {
      const config = await tx.privateBrainConfig.upsert({
        where: { agentId },
        create: {
          agentId,
          ownerId,
          privateBrainEnabled: true,
          perValidator: validator,
          perValidatorPubkey: validatorPubkey,
          memorySlots: opts.memorySlots ?? 8,
          geofenceRegions: normalizeGeofenceRegions(opts.geofenceRegions),
          ofacCheckEnabled: true,
          status: "inactive",
          stateAccountPubkey: null,
          permissionAccountPubkey: null,
          delegationTxSignature: null,
        },
        update: {
          privateBrainEnabled: true,
          perValidator: validator,
          perValidatorPubkey: validatorPubkey,
          memorySlots: opts.memorySlots ?? 8,
          geofenceRegions: normalizeGeofenceRegions(opts.geofenceRegions),
          status: "inactive",
          stateAccountPubkey: null,
          permissionAccountPubkey: null,
          delegationTxSignature: null,
          updatedAt: new Date(),
        },
      });

      await tx.privateBrainAudit.create({
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
   * then verifies the state account is properly delegated
   */
  static async delegate(
    agentId: string,
    ownerId: string,
    stateAccountPubkey: string,
    permissionAccountPubkey: string,
    signedTx: string
  ) {
    const config = await prisma.privateBrainConfig.findUnique({
      where: { agentId },
    });

    if (!config || !config.privateBrainEnabled) {
      throw new Error("Private Brain is not enabled for this agent.");
    }

    const rpcUrl = process.env.SOLANA_RPC_URL ?? "http://127.0.0.1:8899";
    const connection = new Connection(rpcUrl, "confirmed");

    // Submit the delegation transaction to L1
    const txSig = await submitAndConfirmDelegationTx(connection, signedTx);

    // Verify the state account is now delegated to the delegation program
    await verifyAccountDelegated(connection, new PublicKey(stateAccountPubkey));

    return prisma.$transaction(async (tx) => {
      const updated = await tx.privateBrainConfig.update({
        where: { agentId },
        data: {
          status: "active",
          stateAccountPubkey,
          permissionAccountPubkey,
          delegationTxSignature: txSig,
          updatedAt: new Date(),
        },
      });

      await tx.privateBrainAudit.create({
        data: {
          configId: config.id,
          agentId,
          actorId: ownerId,
          action: "delegate",
          previousStatus: config.status,
          newStatus: "active",
          metadata: { stateAccountPubkey, permissionAccountPubkey, txSig },
        },
      });

      return updated;
    });
  }

  /**
   * Disable private brain for an agent
   * Schedules undelegation job if currently active
   */
  static async disable(agentId: string, ownerId: string) {
    const config = await prisma.privateBrainConfig.findUnique({
      where: { agentId },
    });

    if (!config) {
      throw new Error("Private Brain is not configured for this agent.");
    }

    // If state is still delegated, schedule undelegation for the worker
    if (config.stateAccountPubkey && config.status === "active") {
      await scheduleUndelegation(agentId, ownerId, config.stateAccountPubkey, config.perValidator);
    }

    return prisma.$transaction(async (tx) => {
      const updated = await tx.privateBrainConfig.update({
        where: { agentId },
        data: {
          privateBrainEnabled: false,
          status: "inactive",
          stateAccountPubkey: null,
          permissionAccountPubkey: null,
          delegationTxSignature: null,
          updatedAt: new Date(),
        },
      });

      await tx.privateBrainAudit.create({
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
   * Get the configuration for an agent's private brain
   * Includes recent audit trail
   */
  static async getConfig(agentId: string, ownerId: string) {
    return prisma.privateBrainConfig.findFirst({
      where: { agentId, ownerId },
      include: {
        audits: {
          orderBy: { createdAt: "desc" },
          take: 10,
        },
      },
    });
  }

  /**
   * Read encrypted state from the TEE RPC
   * Only works if the account is actively delegated
   */
  static async readStateFromTee(agentId: string, ownerId: string): Promise<Buffer | null> {
    const config = await prisma.privateBrainConfig.findFirst({
      where: { agentId, ownerId, status: "active" },
    });

    if (!config?.stateAccountPubkey) {
      return null;
    }

    const validator = config.perValidator;
    const endpoint = getValidatorEndpoint(validator);

    // Connect to TEE RPC (not L1)
    const teeConnection = new Connection(endpoint, "confirmed");

    try {
      const info = await getAccountInfo(
        teeConnection,
        new PublicKey(config.stateAccountPubkey)
      );
      return info?.data ?? null;
    } catch (err) {
      console.error(
        `[PrivateBrain] Failed to read state from TEE for agent ${agentId}:`,
        err
      );
      return null;
    }
  }
}