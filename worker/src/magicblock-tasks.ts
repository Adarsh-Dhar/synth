import { Connection } from "@solana/web3.js";
import prisma from "./lib/prisma.js";

type TaskHandle = {
  stop: () => void;
};

type JsonRecord = Record<string, unknown>;

const VALIDATOR_ENDPOINTS: Record<string, string> = {
  "mainnet-tee.magicblock.app": "https://mainnet-tee.magicblock.app",
  "devnet-tee.magicblock.app": "https://devnet-tee.magicblock.app",
  "as.magicblock.app": "https://as.magicblock.app",
  "eu.magicblock.app": "https://eu.magicblock.app",
  "us.magicblock.app": "https://us.magicblock.app",
  "devnet-as.magicblock.app": "https://devnet-as.magicblock.app",
  "devnet-eu.magicblock.app": "https://devnet-eu.magicblock.app",
  "devnet-us.magicblock.app": "https://devnet-us.magicblock.app",
  "localhost:7799": "http://localhost:7799",
};

function resolveValidatorEndpoint(validator: string): string {
  const endpoint = VALIDATOR_ENDPOINTS[validator];
  if (!endpoint) {
    throw new Error(`Unknown validator: ${validator}`);
  }
  return endpoint;
}

function getOperatorCredentials(): { pubkey: string; signature: string } {
  const pubkey = String(process.env.MAGICBLOCK_OPERATOR_PUBKEY ?? "").trim();
  const signature = String(process.env.MAGICBLOCK_OPERATOR_SIGNATURE ?? "").trim();

  if (!pubkey || !signature) {
    throw new Error("Missing MAGICBLOCK_OPERATOR_PUBKEY or MAGICBLOCK_OPERATOR_SIGNATURE");
  }

  return { pubkey, signature };
}

async function getValidatorAuthToken(validatorEndpoint: string): Promise<string> {
  const { pubkey, signature } = getOperatorCredentials();
  const response = await fetch(`${validatorEndpoint}/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ pubkey, signature }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Failed to authenticate with MagicBlock validator [${response.status}]: ${body}`);
  }

  const payload = (await response.json()) as { token?: string };
  if (!payload.token) {
    throw new Error("MagicBlock validator auth response did not include a token");
  }

  return payload.token;
}

async function submitTxToEndpoint(endpoint: string, authToken: string | null, rawTxBase64: string): Promise<string> {
  const txBytes = Buffer.from(rawTxBase64, "base64");
  const connection = new Connection(endpoint, {
    commitment: "confirmed",
    httpHeaders: authToken ? { Authorization: `Bearer ${authToken}` } : undefined,
  });

  const signature = await connection.sendRawTransaction(txBytes, {
    skipPreflight: true,
    preflightCommitment: "confirmed",
  });

  await connection.confirmTransaction(signature, "confirmed");
  return signature;
}

function asRecord(value: unknown): JsonRecord | null {
  return value && typeof value === "object" ? (value as JsonRecord) : null;
}

function getTxPayload(metadata: unknown, metadataKey: string, envVarName: string): string {
  const record = asRecord(metadata);
  const fromMetadata = String(record?.[metadataKey] ?? "").trim();
  const fromEnv = String(process.env[envVarName] ?? "").trim();
  return fromMetadata || fromEnv;
}

async function submitAndConfirmRawTx(endpoint: string, rawTxBase64: string): Promise<string> {
  const txBytes = Buffer.from(rawTxBase64, "base64");
  const connection = new Connection(endpoint, "confirmed");
  const signature = await connection.sendRawTransaction(txBytes, {
    skipPreflight: true,
    preflightCommitment: "confirmed",
  });
  await connection.confirmTransaction(signature, "confirmed");
  return signature;
}

async function processPrivateBrainUndelegations(): Promise<number> {
  const jobs = await prisma.privateBrainAudit.findMany({
    where: { action: "undelegate_scheduled" },
    orderBy: { createdAt: "asc" },
    take: 25,
    include: { config: true },
  });

  let processed = 0;
  for (const job of jobs) {
    const config = job.config;
    const metadata = asRecord(job.metadata);

    if (config.status !== "undelegating" || !config.stateAccountPubkey) {
      continue;
    }

    const existingWorkerStatus = String(metadata?.workerStatus ?? "");
    const lastAttemptAt = metadata?.workerLastAttemptAt ? Number(metadata.workerLastAttemptAt) : 0;
    if (existingWorkerStatus === "waiting_for_tx" && lastAttemptAt && Date.now() - lastAttemptAt < 60_000) {
      continue;
    }

    const rawTxBase64 = getTxPayload(metadata, "undelegateTxBase64", "MAGICBLOCK_UNDELEGATE_TX_BASE64");
    if (!rawTxBase64) {
      await prisma.privateBrainAudit.update({
        where: { id: job.id },
        data: {
          metadata: {
            ...(metadata ?? {}),
            workerStatus: "waiting_for_tx",
            workerLastAttemptAt: Date.now(),
          },
        },
      });
      continue;
    }

    const endpoint = resolveValidatorEndpoint(config.perValidator);
    const txSig = await submitAndConfirmRawTx(endpoint, rawTxBase64);

    await prisma.$transaction(async (tx) => {
      await tx.privateBrainConfig.update({
        where: { agentId: config.agentId },
        data: {
          privateBrainEnabled: false,
          status: "inactive",
          stateAccountPubkey: null,
          permissionAccountPubkey: null,
          delegationTxSignature: null,
          undelegationTxSignature: txSig,
          updatedAt: new Date(),
        },
      });

      await tx.privateBrainAudit.update({
        where: { id: job.id },
        data: {
          metadata: {
            ...(metadata ?? {}),
            workerStatus: "submitted",
            workerLastAttemptAt: Date.now(),
            txSig,
          },
        },
      });
    });

    processed += 1;
  }

  return processed;
}

async function processShieldedSettlements(): Promise<number> {
  const configs = await prisma.shieldedExecutionConfig.findMany({
    where: {
      enabled: true,
      settlementIntervalMs: { gt: 0 },
      status: "active",
    },
    orderBy: { updatedAt: "asc" },
    take: 25,
  });

  const now = Date.now();
  let processed = 0;

  for (const config of configs) {
    const intervalMs = Math.max(0, Number(config.settlementIntervalMs ?? 0));
    const lastSettlementAt = config.lastSettlementAt?.getTime() ?? 0;
    const due = !lastSettlementAt || now - lastSettlementAt >= intervalMs;
    if (!due) {
      continue;
    }

    const rawTxBase64 = getTxPayload(undefined, "settlementTxBase64", "MAGICBLOCK_SETTLEMENT_TX_BASE64");
    if (rawTxBase64) {
      const endpoint = resolveValidatorEndpoint(config.perValidator);
      const token = await getValidatorAuthToken(endpoint);
      await submitTxToEndpoint(endpoint, token, rawTxBase64);
    }

    await prisma.shieldedExecutionConfig.update({
      where: { agentId: config.agentId },
      data: {
        totalSettledTxs: { increment: 1 },
        lastSettlementAt: new Date(now),
        updatedAt: new Date(now),
      },
    });

    processed += 1;
  }

  return processed;
}

export async function runMagicBlockTasksOnce(): Promise<{ undelegations: number; settlements: number }> {
  const [undelegations, settlements] = await Promise.all([
    processPrivateBrainUndelegations(),
    processShieldedSettlements(),
  ]);

  return { undelegations, settlements };
}

export function startMagicBlockTasks(pollIntervalMs = Number(process.env.MAGICBLOCK_TASK_POLL_INTERVAL_MS ?? 30_000)): TaskHandle {
  let active = true;
  const timer = setInterval(() => {
    void runMagicBlockTasksOnce().catch((error) => {
      console.error("[magicblock-tasks] run failed:", error);
    });
  }, pollIntervalMs);

  timer.unref?.();
  void runMagicBlockTasksOnce().catch((error) => {
    console.error("[magicblock-tasks] initial run failed:", error);
  });

  return {
    stop: () => {
      if (!active) return;
      active = false;
      clearInterval(timer);
    },
  };
}
