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

export type ShieldedOpts = {
  validator?: string;
  shieldStrategyLogic?: boolean;
  shieldIntent?: boolean;
  shieldIntermediateStates?: boolean;
  settlementMode?: "net_only" | "batch_compressed" | "full";
  settlementIntervalMs?: number;
};

function resolveValidatorPubkey(validator: string): string {
  const pubkey = VALIDATOR_PUBKEYS[validator];
  if (!pubkey) throw new Error(`Unknown validator: ${validator}`);
  return pubkey;
}

export class ShieldedExecutionService {
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

  static async enable(agentId: string, ownerId: string, opts: ShieldedOpts = {}) {
    await this.assertEnterprise(ownerId);

    const validator = opts.validator ?? "devnet-tee.magicblock.app";
    const validatorPubkey = resolveValidatorPubkey(validator);

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
          metadata: { validator, validatorPubkey },
        },
      });

      return config;
    });
  }

  static async delegate(
    agentId: string,
    ownerId: string,
    logicAccountPubkey: string,
    stateAccountPubkey: string,
    permissionAccountPubkey: string,
    signedTx: string
  ) {
    const config = await prisma.shieldedExecutionConfig.findUnique({ where: { agentId } });
    if (!config || !config.enabled) {
      throw new Error("Shielded Execution is not enabled for this agent.");
    }

    return prisma.$transaction(async (tx) => {
      const updated = await tx.shieldedExecutionConfig.update({
        where: { agentId },
        data: {
          status: "delegating",
          logicAccountPubkey,
          stateAccountPubkey,
          permissionAccountPubkey,
          delegationTxSignature: signedTx,
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
          newStatus: "delegating",
          metadata: { logicAccountPubkey, stateAccountPubkey, signedTx },
        },
      });

      return updated;
    });
  }

  static async recordSettlement(agentId: string) {
    await prisma.shieldedExecutionConfig.update({
      where: { agentId },
      data: {
        totalSettledTxs: { increment: 1 },
        lastSettlementAt: new Date(),
        updatedAt: new Date(),
      },
    });
  }

  static async disable(agentId: string, ownerId: string) {
    const config = await prisma.shieldedExecutionConfig.findUnique({ where: { agentId } });
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
          metadata: {},
        },
      });

      return updated;
    });
  }

  static getConfig(agentId: string, ownerId: string) {
    return prisma.shieldedExecutionConfig.findFirst({
      where: { agentId, ownerId },
      include: {
        audits: { orderBy: { createdAt: "desc" }, take: 10 },
      },
    });
  }
}