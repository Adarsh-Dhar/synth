import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  return {
    prisma: {
      user: { findUnique: vi.fn() },
      botWallet: { upsert: vi.fn(), findUnique: vi.fn(), update: vi.fn() },
      botService: { create: vi.fn(), update: vi.fn(), findMany: vi.fn() },
      botServiceWhitelist: { upsert: vi.fn() },
      a2APaymentChannel: { create: vi.fn(), update: vi.fn(), findUnique: vi.fn(), findUniqueOrThrow: vi.fn() },
      a2APayment: { create: vi.fn(), aggregate: vi.fn(), update: vi.fn(), findUnique: vi.fn(), findUniqueOrThrow: vi.fn() },
      agent: { findUnique: vi.fn() },
      $transaction: vi.fn(async (callback: (tx: unknown) => Promise<unknown>) => callback({})),
    },
    privatePaymentsRequest: vi.fn(),
    verifyTransactionStatus: vi.fn(),
    connectionInstances: [] as Array<{ sendRawTransaction: ReturnType<typeof vi.fn>; confirmTransaction: ReturnType<typeof vi.fn> }>,
  };
});

vi.mock("@/lib/prisma", () => ({ prisma: mocks.prisma }));
vi.mock("@/lib/magicblock-http", () => ({
  privatePaymentsRequest: mocks.privatePaymentsRequest,
}));
vi.mock("@/lib/solana-tx-utils", () => ({
  verifyTransactionStatus: mocks.verifyTransactionStatus,
}));
vi.mock("@solana/web3.js", async () => {
  const actual = await vi.importActual<typeof import("@solana/web3.js")>("@solana/web3.js");

  class MockConnection {
    sendRawTransaction = vi.fn(async () => "mock-tx-sig");
    confirmTransaction = vi.fn(async () => ({ value: { err: null } }));

    constructor(public endpoint: string, public options: unknown) {
      mocks.connectionInstances.push(this);
    }
  }

  return { ...actual, Connection: MockConnection };
});

import { A2APaymentService } from "@/lib/a2a-payment";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.prisma.user.findUnique.mockResolvedValue({ plan: "enterprise", planExpiresAt: null });
  mocks.prisma.botWallet.upsert.mockResolvedValue({ id: "wallet-1", agentId: "agent-1", pubkey: "wallet-pubkey" });
  mocks.prisma.botWallet.findUnique.mockResolvedValue({ id: "wallet-1", agentId: "agent-1", ownerId: "user-1", pubkey: "wallet-pubkey" });
  mocks.prisma.botWallet.update.mockResolvedValue({ id: "wallet-1" });
  mocks.prisma.botService.create.mockResolvedValue({ id: "service-1" });
  mocks.prisma.botService.update.mockResolvedValue({ id: "service-1" });
  mocks.prisma.botService.findMany.mockResolvedValue([]);
  mocks.prisma.a2APaymentChannel.create.mockResolvedValue({ id: "channel-1", status: "pending" });
  mocks.prisma.a2APaymentChannel.update.mockResolvedValue({ id: "channel-1", status: "open" });
  mocks.prisma.a2APaymentChannel.findUnique.mockResolvedValue({
    id: "channel-1",
    payerAgentId: "payer-1",
    payeeAgentId: "payee-1",
    status: "open",
    maxPerTxMicro: 1_000_000,
    dailyCapMicro: 5_000_000,
    channelAccountPubkey: "channel-pubkey",
  });
  mocks.prisma.a2APaymentChannel.findUniqueOrThrow.mockResolvedValue({
    id: "channel-1",
    payerAgentId: "payer-1",
    payeeAgentId: "payee-1",
    status: "open",
    maxPerTxMicro: 1_000_000,
    dailyCapMicro: 5_000_000,
    channelAccountPubkey: "channel-pubkey",
  });
  mocks.prisma.a2APayment.aggregate.mockResolvedValue({ _sum: { amountMicro: 0 } });
  mocks.prisma.a2APayment.create.mockResolvedValue({ id: "payment-1", status: "confirmed" });
  mocks.prisma.a2APayment.update.mockResolvedValue({ id: "payment-1", status: "confirmed" });
  mocks.prisma.a2APayment.findUnique.mockResolvedValue({ id: "payment-1", channelId: "channel-1", amountMicro: 100 });
  mocks.prisma.a2APayment.findUniqueOrThrow.mockResolvedValue({ id: "payment-1", channelId: "channel-1", amountMicro: 100 });
  mocks.prisma.agent.findUnique.mockResolvedValue({ userId: "user-1" });
  mocks.privatePaymentsRequest.mockResolvedValue({ txHash: "tx-hash-1", channelAccountPubkey: "channel-pubkey" });
  mocks.verifyTransactionStatus.mockResolvedValue({ confirmed: true });
});

describe("A2APaymentService", () => {
  it("creates a wallet and registers it with Private Payments", async () => {
    const wallet = await A2APaymentService.createWallet("agent-1", "user-1", "wallet-pubkey");

    expect(mocks.privatePaymentsRequest).toHaveBeenCalledWith(
      "agent-1",
      "POST",
      "/deposit",
      expect.objectContaining({ pubkey: "wallet-pubkey", agentId: "agent-1" })
    );
    expect(mocks.prisma.botWallet.upsert).toHaveBeenCalled();
    expect(wallet).toEqual({ id: "wallet-1", agentId: "agent-1", pubkey: "wallet-pubkey" });
  });

  it("enables private payments and returns the raw API key", async () => {
    const apiKey = await A2APaymentService.enablePrivatePayments("agent-1", "user-1");

    expect(apiKey.startsWith("ppa_")).toBe(true);
    expect(mocks.privatePaymentsRequest).toHaveBeenCalledWith(
      "agent-1",
      "POST",
      "/register-key",
      expect.objectContaining({ pubkey: "wallet-pubkey" })
    );
    expect(mocks.prisma.botWallet.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { agentId: "agent-1" },
        data: expect.objectContaining({ privatePaymentsEnabled: true }),
      })
    );
  });

  it("opens and pays through a channel", async () => {
    const channel = await A2APaymentService.openChannel("payer-1", "payee-1", "service-1", {
      currency: "USDC",
      maxPerTxMicro: 1_000_000,
      dailyCapMicro: 5_000_000,
    });

    expect(channel.status).toBe("pending");
    expect(mocks.privatePaymentsRequest).toHaveBeenCalledWith(
      "payer-1",
      "POST",
      "/channels/open",
      expect.objectContaining({ payeePubkey: "wallet-pubkey" })
    );

    const payment = await A2APaymentService.pay(
      "channel-1",
      "payer-1",
      "payee-1",
      250,
      "USDC",
      "test payment",
      "idem-1"
    );

    expect(mocks.privatePaymentsRequest).toHaveBeenCalledWith(
      "payer-1",
      "POST",
      "/transfer",
      expect.objectContaining({
        channelAccountPubkey: "channel-pubkey",
        amountMicro: 250,
        currency: "USDC",
      })
    );
    expect(payment).toEqual({ id: "payment-1", status: "confirmed" });
  });
});