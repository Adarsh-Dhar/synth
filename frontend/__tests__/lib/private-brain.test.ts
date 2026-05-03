import { beforeEach, describe, expect, it, vi } from "vitest";
import { PublicKey } from "@solana/web3.js";

const mocks = vi.hoisted(() => {
  const txConfig = {
    privateBrainConfig: {
      upsert: vi.fn(),
      update: vi.fn(),
      findUnique: vi.fn(),
      findFirst: vi.fn(),
    },
    privateBrainAudit: {
      create: vi.fn(),
      update: vi.fn(),
    },
  };

  return {
    prisma: {
      user: { findUnique: vi.fn() },
      privateBrainConfig: txConfig.privateBrainConfig,
      privateBrainAudit: txConfig.privateBrainAudit,
      $transaction: vi.fn(async (callback: (tx: typeof txConfig) => Promise<unknown>) => callback(txConfig)),
    },
    txConfig,
    getSlot: vi.fn(),
    getAccountInfo: vi.fn(),
    submitAndConfirmTx: vi.fn(),
    getValidatorEndpoint: vi.fn(),
    getValidatorPubkey: vi.fn(),
    isValidValidator: vi.fn(),
    connectionInstances: [] as Array<{
      endpoint: string;
      options: unknown;
      getVersion: ReturnType<typeof vi.fn>;
      sendRawTransaction: ReturnType<typeof vi.fn>;
      confirmTransaction: ReturnType<typeof vi.fn>;
    }>,
  };
});

vi.mock("@/lib/prisma", () => ({ prisma: mocks.prisma }));
vi.mock("@/lib/validators-config", () => ({
  getValidatorEndpoint: mocks.getValidatorEndpoint,
  getValidatorPubkey: mocks.getValidatorPubkey,
  isValidValidator: mocks.isValidValidator,
}));
vi.mock("@/lib/solana-tx-utils", () => ({
  submitAndConfirmTx: mocks.submitAndConfirmTx,
  getSlot: mocks.getSlot,
  getAccountInfo: mocks.getAccountInfo,
  verifyAccountOwner: vi.fn(),
}));
vi.mock("@solana/web3.js", async () => {
  const actual = await vi.importActual<typeof import("@solana/web3.js")>("@solana/web3.js");

  class MockConnection {
    endpoint: string;
    options: unknown;
    getVersion = vi.fn(async () => ({ "solana-core": "1.0.0" }));
    sendRawTransaction = vi.fn(async () => "mock-tx-sig");
    confirmTransaction = vi.fn(async () => ({ value: { err: null } }));

    constructor(endpoint: string, options: unknown) {
      this.endpoint = endpoint;
      this.options = options;
      mocks.connectionInstances.push(this);
    }
  }

  return { ...actual, Connection: MockConnection };
});

import { PrivateBrainService } from "@/lib/private-brain";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getValidatorEndpoint.mockReturnValue("https://devnet-tee.magicblock.app");
  mocks.getValidatorPubkey.mockReturnValue("validator-pubkey");
  mocks.isValidValidator.mockReturnValue(true);
  mocks.getSlot.mockResolvedValue(101);
  mocks.getAccountInfo.mockResolvedValue(null);
  mocks.submitAndConfirmTx.mockResolvedValue("delegation-sig");
  mocks.prisma.user.findUnique.mockResolvedValue({ plan: "enterprise", planExpiresAt: null });
  mocks.prisma.privateBrainAudit.create.mockResolvedValue({ id: "audit-schedule" });
  mocks.txConfig.privateBrainConfig.upsert.mockResolvedValue({ id: "cfg-1", agentId: "agent-1" });
  mocks.txConfig.privateBrainConfig.update.mockResolvedValue({ id: "cfg-1", agentId: "agent-1" });
  mocks.txConfig.privateBrainConfig.findUnique.mockResolvedValue({
    id: "cfg-1",
    agentId: "agent-1",
    ownerId: "user-1",
    status: "active",
    privateBrainEnabled: true,
    perValidator: "devnet-tee.magicblock.app",
    stateAccountPubkey: "11111111111111111111111111111111",
  });
  mocks.txConfig.privateBrainConfig.findFirst.mockResolvedValue({
    id: "cfg-1",
    agentId: "agent-1",
    ownerId: "user-1",
    status: "active",
    perValidator: "devnet-tee.magicblock.app",
    stateAccountPubkey: "11111111111111111111111111111111",
  });
});

describe("PrivateBrainService", () => {
  it("enables private brain with validator health check", async () => {
    const config = await PrivateBrainService.enable("agent-1", "user-1", {
      validator: "devnet-tee.magicblock.app",
      memorySlots: 12,
      geofenceRegions: ["us", "eu"],
    });

    expect(mocks.getSlot).toHaveBeenCalled();
    expect(mocks.txConfig.privateBrainConfig.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { agentId: "agent-1" },
        create: expect.objectContaining({
          ownerId: "user-1",
          perValidator: "devnet-tee.magicblock.app",
          memorySlots: 12,
          geofenceRegions: ["us", "eu"],
        }),
      })
    );
    expect(config).toEqual({ id: "cfg-1", agentId: "agent-1" });
  });

  it("delegates a state account and persists the tx signature", async () => {
    const delegatedOwner = new PublicKey("DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMARRSaeSh");
    mocks.getAccountInfo.mockResolvedValue({ owner: delegatedOwner, data: Buffer.from("state") });

    await PrivateBrainService.delegate(
      "agent-1",
      "user-1",
      "11111111111111111111111111111111",
      "So11111111111111111111111111111111111111112",
      "c2lnbmVkLXR4"
    );

    expect(mocks.submitAndConfirmTx).toHaveBeenCalledWith(expect.anything(), "c2lnbmVkLXR4", 3);
    expect(mocks.txConfig.privateBrainConfig.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { agentId: "agent-1" },
        data: expect.objectContaining({
          status: "active",
          stateAccountPubkey: "11111111111111111111111111111111",
          permissionAccountPubkey: "So11111111111111111111111111111111111111112",
          delegationTxSignature: "delegation-sig",
        }),
      })
    );
  });

  it("schedules undelegation on disable and records the owner as actor", async () => {
    await PrivateBrainService.disable("agent-1", "user-1");

    expect(mocks.txConfig.privateBrainAudit.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          actorId: "user-1",
          action: "undelegate_scheduled",
          newStatus: "undelegating",
        }),
      })
    );
    expect(mocks.txConfig.privateBrainConfig.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { agentId: "agent-1" },
        data: expect.objectContaining({
          privateBrainEnabled: false,
          status: "inactive",
        }),
      })
    );
  });

  it("reads state data from the validator endpoint", async () => {
    mocks.getAccountInfo.mockResolvedValue({ owner: new PublicKey("11111111111111111111111111111111"), data: Buffer.from("secret-state") });

    const state = await PrivateBrainService.readStateFromTee("agent-1", "user-1");

    expect(state?.toString()).toBe("secret-state");
  });
});