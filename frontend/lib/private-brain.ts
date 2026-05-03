import { prisma } from "@/lib/prisma";

const VALIDATOR_PUBKEYS: Record<string, string> = {
  "mainnet-tee.magicblock.app": "MTEWGuqxUpYZGFJQcp8tLN7x5v9BSeoFHYWQQ3n3xzo",
  "devnet-tee.magicblock.app": "MTEWGuqxUpYZGFJQcp8tLN7x5v9BSeoFHYWQQ3n3xzo",
  "as.magicblock.app": "MAS1Dt9qreoRMQ14YQuhg8UTZMMzDdKhmkZMECCzk57",
  "eu.magicblock.app": "MEUGGrYPxKk17hCr7wpT6s8dtNokZj5U2L57vjYMS8e",
  "us.magicblock.app": "MUS3hc9TCw4cGC12vHNoYcCGzJG1txjgQLZWVoeNHNd",
  "devnet-as.magicblock.app": "MAS1Dt9qreoRMQ14YQuhg8UTZMMzDdKhmkZMECCzk57",
  "devnet-eu.magicblock.app": "MEUGGrYPxKk17hCr7wpT6s8dtNokZj5U2L57vjYMS8e",
  "devnet-us.magicblock.app": "MUS3hc9TCw4cGC12vHNoYcCGzJG1txjgQLZWVoeNHNd",
  "localhost:7799": "mAGicPQYBMvcYveUZA5F5UNNwyHvfYh5xkLS2Fr1mev",
};

type PrivateBrainConfigInput = {
  validator?: string;
  memorySlots?: number;
  geofenceRegions?: string[];
};

function resolveValidatorPubkey(validator: string): string {
  const validatorPubkey = VALIDATOR_PUBKEYS[validator];
  if (!validatorPubkey) {
    throw new Error(`Unknown validator: ${validator}`);
  }

  return validatorPubkey;
}

function normalizeGeofenceRegions(regions?: string[]): string[] {
  return Array.isArray(regions)
    ? regions.map((region) => String(region).trim()).filter(Boolean)
    : [];
}

async function assertEnterprise(ownerId: string) {
  const user = await prisma.user.findUnique({
    where: { id: ownerId },
    select: { plan: true, planExpiresAt: true },
  });

  const isEnterprise = String(user?.plan || "free").toLowerCase() === "enterprise";
  const isActive = !user?.planExpiresAt || user.planExpiresAt.getTime() > Date.now();

  if (!isEnterprise || !isActive) {
    throw new Error("ENTERPRISE_REQUIRED");
  }
}

export class PrivateBrainService {
  static async enable(
    agentId: string,
    ownerId: string,
    opts: PrivateBrainConfigInput = {}
  ) {
    await assertEnterprise(ownerId);

    const validator = opts.validator ?? "devnet-tee.magicblock.app";
    const validatorPubkey = resolveValidatorPubkey(validator);

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
          metadata: { validator, validatorPubkey },
        },
      });

      return config;
    });
  }

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

    return prisma.$transaction(async (tx) => {
      const updated = await tx.privateBrainConfig.update({
        where: { agentId },
        data: {
          status: "delegating",
          stateAccountPubkey,
          permissionAccountPubkey,
          delegationTxSignature: signedTx,
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
          newStatus: "delegating",
          metadata: { stateAccountPubkey, permissionAccountPubkey, signedTx },
        },
      });

      return updated;
    });
  }

  static async disable(agentId: string, ownerId: string) {
    const config = await prisma.privateBrainConfig.findUnique({
      where: { agentId },
    });

    if (!config) {
      throw new Error("Private Brain is not configured for this agent.");
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
          metadata: {},
        },
      });

      return updated;
    });
  }

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
}