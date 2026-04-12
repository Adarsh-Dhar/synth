import "dotenv/config";
import axios from "axios";
import { shouldUseLegacyDeterministicFallback } from "./lib/intent/mcp-sanitizer.ts";

type Json = Record<string, unknown>;

const BASE_URL = process.env.BASE_URL ?? "http://127.0.0.1:3000";

const SOLANA_PROMPT =
  process.env.TEST_SOLANA_PROMPT ??
  "Write a Solana Yield Sweeper bot in TypeScript: every 15s read the SOL balance for USER_WALLET_ADDRESS and transfer to RECIPIENT_ADDRESS when balance > 0.1 SOL. Chain: Solana. Strategy: yield.";

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

function parseJsonText(text: string): Json {
  try {
    return JSON.parse(text) as Json;
  } catch {
    return {};
  }
}

async function fetchJson(url: string, init: RequestInit, timeoutMs: number): Promise<{ status: number; text: string; data: Json }> {
  const res = await axios({ url, method: (init.method || "GET") as any, headers: init.headers as any, data: init.body as any, timeout: timeoutMs, validateStatus: () => true } as any);
  const text = typeof res.data === "string" ? res.data : JSON.stringify(res.data);
  return { status: res.status, text, data: parseJsonText(text) };
}

async function testSolanaIntentDetection(): Promise<void> {
  const response = await fetchJson(
    `${BASE_URL}/api/classify-intent`,
    { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ prompt: SOLANA_PROMPT }) },
    60_000,
  );

  assert(response.status === 200, `classify-intent failed (${response.status}): ${response.text.slice(0, 400)}`);
  const intent = (response.data.intent ?? {}) as Json;
  assert(String(intent.chain ?? "").toLowerCase() === "solana", "intent should classify to chain=solana");
  assert(String(intent.strategy ?? "").toLowerCase() === "yield", "intent should classify to strategy=yield");
  // ensure legacy deterministic fallback remains disabled by default
  assert(!shouldUseLegacyDeterministicFallback(), "deterministic legacy fallback should be disabled by default");
  console.log("[ok] Solana intent detection smoke test passed");
}

async function testGenericPromptPrefersSolana(): Promise<void> {
  const response = await fetchJson(
    `${BASE_URL}/api/classify-intent`,
    { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ prompt: "Build a flash loan arbitrage bot on base" }) },
    60_000,
  );

  assert(response.status === 200, `generic classify-intent failed (${response.status}): ${response.text.slice(0, 400)}`);
  const intent = (response.data.intent ?? {}) as Json;
  assert(String(intent.chain ?? "").toLowerCase() === "solana", "generic prompt should classify to chain=solana after migration");
  console.log("[ok] generic prompt fallback to solana smoke test passed");
}

async function testCrossChainIntentClassification(): Promise<void> {
  const cases = [
    {
      prompt: "Build an omni-chain liquidation sniper for Solana that watches unhealthy lending positions and bridges USDC when health factor drops.",
      strategy: "cross_chain_liquidation",
    },
    {
      prompt: "Build a flash-bridge spatial arbitrage bot for Solana that bridges between two clusters and sells into the higher price pool.",
      strategy: "cross_chain_arbitrage",
    },
    {
      prompt: "Build an omni-chain yield nomad that auto-compounds across Solana clusters and rebalances when APY gaps justify the bridge cost.",
      strategy: "cross_chain_sweep",
    },
  ];

  for (const testCase of cases) {
    const response = await fetchJson(
      `${BASE_URL}/api/classify-intent`,
      { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ prompt: testCase.prompt }) },
      60_000,
    );

    assert(response.status === 200, `cross-chain classify-intent failed (${response.status}): ${response.text.slice(0, 400)}`);
    const intent = (response.data.intent ?? {}) as Json;
    assert(String(intent.chain ?? "").toLowerCase() === "solana", "cross-chain prompt should classify to chain=solana");
    assert(String(intent.strategy ?? "").toLowerCase() === testCase.strategy, `cross-chain prompt should classify to strategy=${testCase.strategy}`);
  }

  console.log("[ok] cross-chain intent classification smoke test passed");
}

async function run(): Promise<void> {
  console.log("\n=== Solana Smoke Tests ===");
  console.log(`BASE_URL=${BASE_URL}`);

  await testSolanaIntentDetection();
  await testGenericPromptPrefersSolana();
  await testCrossChainIntentClassification();

  console.log("\n[pass] all Solana smoke checks passed");
}

run().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error("\n[FAIL]", message);
  process.exit(1);
});
