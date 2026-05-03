import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const txConfig = {
    shieldedExecutionConfig: {
      upsert: vi.fn(),
      update: vi.fn(),
      findUnique: vi.fn(),
      findFirst: vi.fn(),
    },
    shieldedExecutionAudit: {
      create: vi.fn(),
    },
  };

  return {
    prisma: {
      user: { findUnique: vi.fn() },
      shieldedExecutionConfig: txConfig.shieldedExecutionConfig,
      shieldedExecutionAudit: txConfig.shieldedExecutionAudit,
      $transaction: vi.fn(async (callback: (tx: typeof txConfig) => Promise<unknown>) => callback(txConfig)),
    },
    txConfig,
    getSlot: vi.fn(),
    getValidatorEndpoint: vi.fn(),
    getValidatorPubkey: vi.fn(),
    isValidValidator: vi.fn(),
    getValidatorAuthToken: vi.fn(),
    connectionInstances: [] as Array<{ sendRawTransaction: ReturnType<typeof vi.fn>; confirmTransaction: ReturnType<typeof vi.fn> }>,
  };
});

vi.mock("@/lib/prisma", () => ({ prisma: mocks.prisma }));
vi.mock("@/lib/validators-config", () => ({
  getValidatorEndpoint: mocks.getValidatorEndpoint,
  getValidatorPubkey: mocks.getValidatorPubkey,
  isValidValidator: mocks.isValidValidator,
}));
vi.mock("@/lib/solana-tx-utils", () => ({
  submitAndConfirmTx: vi.fn(),
  getSlot: mocks.getSlot,
  getAccountInfo: vi.fn(),
  verifyAccountOwner: vi.fn(),
}));
vi.mock("@/lib/magicblock-http", () => ({
  getValidatorAuthToken: mocks.getValidatorAuthToken,
}));
vi.mock("@solana/web3.js", async () => {
  const actual = await vi.importActual<typeof import("@solana/web3.js")>("@solana/web3.js");

  class MockConnection {
    sendRawTransaction = vi.fn(async () => "mock-settlement-sig");
    confirmTransaction = vi.fn(async () => ({ value: { err: null } }));

    constructor(public endpoint: string, public options: unknown) {
      mocks.connectionInstances.push(this);
    }
  }

  return { ...actual, Connection: MockConnection };
});

import { ShieldedExecutionService } from "@/lib/shielded-execution";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getValidatorEndpoint.mockReturnValue("https://devnet-tee.magicblock.app");
  mocks.getValidatorPubkey.mockReturnValue("validator-pubkey");
  mocks.isValidValidator.mockReturnValue(true);
  mocks.getSlot.mockResolvedValue(202);
  mocks.getValidatorAuthToken.mockResolvedValue("validator-token");
  mocks.prisma.user.findUnique.mockResolvedValue({ plan: "enterprise", planExpiresAt: null });
  mocks.txConfig.shieldedExecutionConfig.upsert.mockResolvedValue({ id: "cfg-1", agentId: "agent-1" });
  mocks.txConfig.shieldedExecutionConfig.update.mockResolvedValue({ id: "cfg-1", agentId: "agent-1" });
  mocks.txConfig.shieldedExecutionConfig.findUnique.mockResolvedValue({
    id: "cfg-1",
    agentId: "agent-1",
    ownerId: "user-1",
    enabled: true,
    status: "active",
    perValidator: "devnet-tee.magicblock.app",
    settlementIntervalMs: 60_000,
  });
  mocks.txConfig.shieldedExecutionConfig.findFirst.mockResolvedValue({
    id: "cfg-1",
    agentId: "agent-1",
    ownerId: "user-1",
    status: "active",
    perValidator: "devnet-tee.magicblock.app",
  });
});

describe("ShieldedExecutionService", () => {
  it("enables shielded execution after checking the validator", async () => {
    const config = await ShieldedExecutionService.enable("agent-1", "user-1", {
      validator: "devnet-tee.magicblock.app",
      settlementMode: "batch_compressed",
      settlementIntervalMs: 30_000,
    });

    expect(mocks.getSlot).toHaveBeenCalled();
    expect(mocks.txConfig.shieldedExecutionConfig.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { agentId: "agent-1" },
        create: expect.objectContaining({
          ownerId: "user-1",
          settlementMode: "batch_compressed",
          settlementIntervalMs: 30_000,
        }),
      })
    );
    expect(config).toEqual({ id: "cfg-1", agentId: "agent-1" });
  });

  it("executes a shielded transaction and increments usage", async () => {
    const txSig = await ShieldedExecutionService.executeShielded("agent-1", "c2hpZWxkZWQtdHgi");

    expect(txSig).toBe("mock-settlement-sig");
    expect(mocks.getValidatorAuthToken).toHaveBeenCalledWith("https://devnet-tee.magicblock.app");
    expect(mocks.txConfig.shieldedExecutionConfig.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { agentId: "agent-1" },
        data: expect.objectContaining({
          totalShieldedOps: { increment: 1n },
        }),
      })
    );
  });

  it("commits and settles through the TEE and records the settlement", async () => {
    const txSig = await ShieldedExecutionService.commitAndSettle("agent-1", "c2V0dGxlbWVudC10eA==");

    expect(txSig).toBe("mock-settlement-sig");
    expect(mocks.getValidatorAuthToken).toHaveBeenCalledWith("https://devnet-tee.magicblock.app");
    expect(mocks.txConfig.shieldedExecutionConfig.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { agentId: "agent-1" },
        data: expect.objectContaining({
          totalSettledTxs: { increment: 1 },
          lastSettlementAt: expect.any(Date),
        }),
      })
    );
  });
});