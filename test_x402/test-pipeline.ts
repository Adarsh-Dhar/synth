/**
 * test-pipeline.ts
 * ──────────────────────────────────────────────────────────────────
 * Local test harness for the x402 payment + product unlock pipeline.
 * Uses all devnet infrastructure — no real money involved.
 *
 * Run:
 *   npx ts-node test-pipeline.ts
 *
 * Required env:
 *   DODO_PAYMENTS_API_KEY=your_test_key
 *   UMBRA_PRIVATE_KEY=<base58 devnet keypair>     (or auto-generated below)
 */

import { Keypair } from "@solana/web3.js";
import bs58 from "bs58";
import { runX402Pipeline, WorkerRequest } from "./worker";

// Load local .env when running this file directly with ts-node.
if (typeof process.loadEnvFile === "function") {
  process.loadEnvFile();
}

function normalizeEnvSecret(value?: string): string | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

// ── Generate a fresh ephemeral devnet keypair if none is set ──────
const configuredSecret =
  normalizeEnvSecret(process.env.PRIVATE_KEY) ??
  normalizeEnvSecret(process.env.UMBRA_PRIVATE_KEY);

const rawKey = configuredSecret
  ? bs58.decode(configuredSecret)
  : Keypair.generate().secretKey;

const agentKeypair = Keypair.fromSecretKey(rawKey);
console.log("🔑 Agent wallet:", agentKeypair.publicKey.toBase58());

// Set devnet endpoints
process.env.SOLANA_RPC_URL       = "https://api.devnet.solana.com";
process.env.MAGICBLOCK_RPC_URL   = "https://devnet-tee.magicblock.app";
process.env.RPC_FAST_URL         = "https://api.devnet.solana.com";


// ── Test payloads ─────────────────────────────────────────────────

const tests: WorkerRequest[] = [
  {
    userId:               "cus_test_synth_001",
    agentWalletSecretKey: bs58.encode(rawKey),
    targetChain:          "solana-devnet",
    product:              "jupiter-cli",
    amountMicrousdc:      1000,
  },
  {
    userId:               "cus_test_synth_001",
    agentWalletSecretKey: bs58.encode(rawKey),
    targetChain:          "solana-devnet",
    product:              "rpc-fast",
    amountMicrousdc:      1200,
  },
];

// ── Run ───────────────────────────────────────────────────────────

async function main() {
  console.log("\n══════════════════════════════════════════════");
  console.log("  synth  x402 unlock pipeline — devnet test   ");
  console.log("══════════════════════════════════════════════\n");

  for (const [i, testReq] of tests.entries()) {
    console.log(`\n── Test ${i + 1}: unlock ${testReq.product} on ${testReq.targetChain} ──`);

    const start = Date.now();
    const result = await runX402Pipeline(testReq);
    const elapsed = Date.now() - start;

    if (result.success) {
      console.log(`\n✅ Pipeline completed in ${elapsed}ms`);
      console.log("   Shielded account :", result.shieldedAccount);
      console.log("   TX signature      :", result.txSignature ?? "(none)");
      console.log("   Data keys         :", result.data ? Object.keys(result.data as object) : "none");
    } else {
      console.error(`\n❌ Pipeline failed at step ${result.step}: ${result.error}`);
    }
  }
}

main().catch(console.error);