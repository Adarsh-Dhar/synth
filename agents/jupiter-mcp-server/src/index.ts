#!/usr/bin/env node
/**
 * Jupiter MCP Server — v2 (Swap V2 + Full API Suite)
 *
 * Transport : Stdio (spawned as subprocess by the Python agent or any MCP host)
 * Purpose   : Context provider + live API bridge for all Jupiter APIs
 *
 * Tools exposed:
 *   search_docs             — Semantic search over Jupiter API documentation
 *   get_order               — Live swap order from Swap V2 /order (Meta-Aggregator)
 *   get_build               — Swap V2 /build instructions for custom transactions
 *   get_token_info          — Token metadata + safety signal (Tokens API V2)
 *   get_price               — Spot price for tokens via Price API V2
 *   list_trigger_orders     — Open limit/OCO/OTOCO orders for a wallet
 *   create_trigger_order    — Place a limit order (single, OCO, or OTOCO)
 *   list_recurring_orders   — Active DCA orders for a wallet
 *   list_lend_markets       — Lending market APYs
 *   list_perp_markets       — Available perpetual markets
 *   list_prediction_markets — Active binary prediction markets
 *   generate_bot_code       — Scaffolded TypeScript for a given strategy
 *
 * NOTE: All endpoints use api.jup.ag with x-api-key header.
 * The legacy quote-api.jup.ag/v6 endpoints are referenced only for backwards compat.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ErrorCode,
  McpError,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import dotenv from "dotenv";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import path from "path";

dotenv.config();

// ─────────────────────────────────────────────
// Config
// ─────────────────────────────────────────────

const API_KEY = process.env.JUPITER_API_KEY?.trim();
if (!API_KEY) {
  process.stderr.write(
    "[jupiter-mcp] WARNING: JUPITER_API_KEY not set. All requests will be rate-limited.\n"
  );
}

const JUPITER_BASE = (
  process.env.JUPITER_BASE_URL ?? "https://api.jup.ag"
).replace(/\/+$/, "");

const TIMEOUT_MS = Number(process.env.JUPITER_TIMEOUT_MS ?? 15_000);
const MAX_RETRIES = Number(process.env.JUPITER_MAX_RETRIES ?? 3);

// ─────────────────────────────────────────────
// Load docs knowledge base
// ─────────────────────────────────────────────

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

interface DocEntry {
  id: string;
  keywords: string[];
  title: string;
  schema: string;
  example?: string;
}

let DOCS: DocEntry[] = [];
try {
  const docsPath = path.resolve(__dirname, "../docs.json");
  DOCS = JSON.parse(readFileSync(docsPath, "utf-8")) as DocEntry[];
  process.stderr.write(`[jupiter-mcp] Loaded ${DOCS.length} doc entries.\n`);
} catch {
  process.stderr.write("[jupiter-mcp] WARNING: docs.json not found — search_docs will return empty.\n");
}

// ─────────────────────────────────────────────
// Zod schemas
// ─────────────────────────────────────────────

const SearchDocsSchema = z.object({
  query: z.string().min(1).max(500),
  include_examples: z.boolean().optional().default(true),
});

// Swap V2 schemas
const GetOrderSchema = z.object({
  input_mint: z.string().min(32).max(44),
  output_mint: z.string().min(32).max(44),
  amount: z.number().int().positive(),
  taker: z.string().min(32).max(44).describe("User wallet public key"),
  slippage_bps: z.number().int().min(0).max(10_000).optional().default(50),
});

const GetBuildSchema = z.object({
  input_mint: z.string().min(32).max(44),
  output_mint: z.string().min(32).max(44),
  amount: z.number().int().positive(),
  taker: z.string().min(32).max(44),
  slippage_bps: z.number().int().min(0).max(10_000).optional().default(50),
  max_accounts: z.number().int().min(1).max(64).optional().default(64),
  mode: z.enum(["fast", "default"]).optional().default("default"),
});

const TokenInfoSchema = z.object({
  mint: z.string().min(32).max(44),
});

const PriceSchema = z.object({
  mints: z.array(z.string().min(32).max(44)).min(1).max(100),
  vs_token: z.string().optional(),
});

const TriggerOrdersSchema = z.object({
  wallet: z.string().min(32).max(44),
});

const CreateTriggerOrderSchema = z.object({
  input_mint: z.string().min(32).max(44),
  output_mint: z.string().min(32).max(44),
  making_amount: z.string().describe("Input amount in base units (string)"),
  taking_amount: z.string().describe("Minimum output amount in base units (string)"),
  user_public_key: z.string().min(32).max(44),
  order_type: z.enum(["single", "OCO", "OTOCO"]).optional().default("single"),
  take_profit_rate: z.string().optional().describe("e.g. '1.15' for +15%"),
  stop_loss_rate: z.string().optional().describe("e.g. '0.92' for -8%"),
  entry_rate: z.string().optional().describe("OTOCO entry trigger rate"),
  expired_at: z.number().int().optional().describe("Unix timestamp expiry"),
});

const RecurringOrdersSchema = z.object({
  wallet: z.string().min(32).max(44),
});

const PredictionMarketsSchema = z.object({
  status: z.enum(["active", "resolved", "all"]).optional().default("active"),
});

const BotCodeSchema = z.object({
  strategy: z.enum([
    "copy_trade",
    "safe_sniper",
    "dca",
    "arbitrage",
    "yield_sweeper",
    "trigger_bot",
    "prediction_arb",
    "perps",
    "flash_arb",
    "adaptive_dca",
    "event_driven",
  ]),
  params: z.record(z.string(), z.unknown()).optional(),
});

// ─────────────────────────────────────────────
// HTTP helper
// ─────────────────────────────────────────────

async function fetchJupiter(
  url: string,
  options: RequestInit = {}
): Promise<unknown> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...(options.headers as Record<string, string>),
  };
  if (API_KEY) headers["x-api-key"] = API_KEY;

  let lastError: Error | null = null;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

    try {
      const res = await fetch(url, { ...options, headers, signal: controller.signal });
      clearTimeout(timer);

      if (res.status === 429) {
        const wait = Number(res.headers.get("Retry-After") ?? 2);
        process.stderr.write(`[jupiter-mcp] 429 rate-limited — waiting ${wait}s (attempt ${attempt}/${MAX_RETRIES})\n`);
        await sleep(wait * 1000);
        continue;
      }

      if (res.status >= 500 && attempt < MAX_RETRIES) {
        process.stderr.write(`[jupiter-mcp] HTTP ${res.status} — retrying (attempt ${attempt}/${MAX_RETRIES})\n`);
        await sleep(500 * attempt);
        continue;
      }

      if (!res.ok) {
        const body = await res.text().catch(() => "(unreadable body)");
        throw new Error(`HTTP ${res.status} ${res.statusText}: ${body}`);
      }

      return await res.json();
    } catch (err) {
      clearTimeout(timer);
      lastError =
        (err as Error).name === "AbortError"
          ? new Error(`Request timed out after ${TIMEOUT_MS}ms (${url})`)
          : (err as Error);

      if (attempt < MAX_RETRIES) await sleep(300 * attempt);
    }
  }

  throw lastError ?? new Error("Unknown fetch error");
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ─────────────────────────────────────────────
// Tool handlers
// ─────────────────────────────────────────────

async function handleSearchDocs(args: unknown) {
  const { query, include_examples } = SearchDocsSchema.parse(args);
  const q = query.toLowerCase();

  const scored = DOCS.map((doc) => {
    let score = 0;
    for (const kw of doc.keywords) {
      if (q.includes(kw)) score += 10;
    }
    const words = q.split(/\s+/);
    for (const word of words) {
      if (word.length < 3) continue;
      if (doc.title.toLowerCase().includes(word)) score += 5;
      if (doc.schema.toLowerCase().includes(word)) score += 2;
      if ((doc.example ?? "").toLowerCase().includes(word)) score += 1;
    }
    return { doc, score };
  })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 5);

  if (scored.length === 0) {
    return {
      message:
        "No documentation found. Available topics: swap, swap_v2, trigger, tokens, lend, perps, " +
        "price, recurring, prediction, dca, flashloan, arbitrage.",
      hint: "Try keywords like 'swap v2 order', 'limit order OCO', 'flash loan arbitrage', 'DCA recurring', 'perps leverage'.",
    };
  }

  return scored.map(({ doc }) => ({
    id: doc.id,
    title: doc.title,
    schema: doc.schema,
    ...(include_examples && doc.example ? { example: doc.example } : {}),
  }));
}

// Swap V2 — Meta-Aggregator: GET /swap/v2/order
async function handleGetOrder(args: unknown) {
  const { input_mint, output_mint, amount, taker, slippage_bps } = GetOrderSchema.parse(args);

  const url =
    `${JUPITER_BASE}/swap/v2/order` +
    `?inputMint=${encodeURIComponent(input_mint)}` +
    `&outputMint=${encodeURIComponent(output_mint)}` +
    `&amount=${amount}` +
    `&taker=${encodeURIComponent(taker)}` +
    `&slippageBps=${slippage_bps}`;

  const data = await fetchJupiter(url);
  return {
    ...(data as object),
    _note:
      "This response contains 'transaction' (base64) and 'requestId'. " +
      "Deserialize the transaction, sign it with the user wallet, then POST to " +
      "/swap/v2/execute with { signedTransaction, requestId } for managed landing.",
  };
}

// Swap V2 — Router: GET /swap/v2/build
async function handleGetBuild(args: unknown) {
  const { input_mint, output_mint, amount, taker, slippage_bps, max_accounts, mode } =
    GetBuildSchema.parse(args);

  const url =
    `${JUPITER_BASE}/swap/v2/build` +
    `?inputMint=${encodeURIComponent(input_mint)}` +
    `&outputMint=${encodeURIComponent(output_mint)}` +
    `&amount=${amount}` +
    `&taker=${encodeURIComponent(taker)}` +
    `&slippageBps=${slippage_bps}` +
    `&maxAccounts=${max_accounts}` +
    `&mode=${mode}`;

  const data = await fetchJupiter(url);
  return {
    ...(data as object),
    _note:
      "Returns raw instructions: computeBudgetInstructions, setupInstructions, " +
      "swapInstruction, cleanupInstruction, addressLookupTableAddresses. " +
      "Assemble your own transaction, sign it, and send via your RPC. " +
      "/execute is NOT available for /build transactions.",
  };
}

async function handleGetTokenInfo(args: unknown) {
  const { mint } = TokenInfoSchema.parse(args);
  const data = await fetchJupiter(`${JUPITER_BASE}/tokens/v2/${encodeURIComponent(mint)}`);

  const token = data as Record<string, unknown>;
  return {
    ...token,
    _safety_summary: {
      is_verified: token.verifiedStatus === "verified",
      organic_score: token.organicScore ?? 0,
      daily_volume_usd: token.volume24h ?? token.daily_volume ?? 0,
      recommendation:
        token.verifiedStatus === "verified" && Number(token.organicScore ?? 0) > 50
          ? "SAFE — verified token with good organic score"
          : token.verifiedStatus === "banned"
          ? "DANGER — banned token, do not trade"
          : Number(token.organicScore ?? 0) < 30
          ? "RISKY — low organic score, potential wash trading"
          : "CAUTION — verify before trading",
    },
  };
}

async function handleGetPrice(args: unknown) {
  const { mints, vs_token } = PriceSchema.parse(args);
  let url = `${JUPITER_BASE}/price/v2?ids=${mints.map(encodeURIComponent).join(",")}`;
  if (vs_token) url += `&vsToken=${encodeURIComponent(vs_token)}`;

  return await fetchJupiter(url);
}

async function handleListTriggerOrders(args: unknown) {
  const { wallet } = TriggerOrdersSchema.parse(args);
  return await fetchJupiter(
    `${JUPITER_BASE}/trigger/v1/openOrders?userPublicKey=${encodeURIComponent(wallet)}`
  );
}

async function handleCreateTriggerOrder(args: unknown) {
  const parsed = CreateTriggerOrderSchema.parse(args);

  const body: Record<string, unknown> = {
    inputMint: parsed.input_mint,
    outputMint: parsed.output_mint,
    makingAmount: parsed.making_amount,
    takingAmount: parsed.taking_amount,
    userPublicKey: parsed.user_public_key,
  };

  if (parsed.order_type !== "single") {
    body.orderType = parsed.order_type;
    if (parsed.take_profit_rate) body.takeProfitRate = parsed.take_profit_rate;
    if (parsed.stop_loss_rate) body.stopLossRate = parsed.stop_loss_rate;
    if (parsed.entry_rate) body.entryRate = parsed.entry_rate;
  }

  if (parsed.expired_at) body.expiredAt = parsed.expired_at;

  const data = await fetchJupiter(`${JUPITER_BASE}/trigger/v1/createOrder`, {
    method: "POST",
    body: JSON.stringify(body),
  });

  return {
    ...(data as object),
    _note: "Sign and send the returned 'transaction' (base64) to execute the limit order.",
  };
}

async function handleListRecurringOrders(args: unknown) {
  const { wallet } = RecurringOrdersSchema.parse(args);
  return await fetchJupiter(
    `${JUPITER_BASE}/recurring/v1/orders?userPublicKey=${encodeURIComponent(wallet)}`
  );
}

async function handleListLendMarkets() {
  const data = await fetchJupiter(`${JUPITER_BASE}/lend/v1/markets`);
  return {
    markets: data,
    _note:
      "Each market has: marketAddress, tokenMint, tokenSymbol, supplyAPY, borrowAPY, " +
      "totalDeposits, totalBorrows, utilizationRate, liquidationThreshold. " +
      "Use supplyAPY for yield comparison in yield_sweeper bots.",
  };
}

async function handleListPerpMarkets() {
  const data = await fetchJupiter(`${JUPITER_BASE}/perps/v1/markets`);
  return {
    markets: data,
    _note: "Each market has: symbol, oraclePrice, fundingRate, openInterest, maxLeverage.",
  };
}

async function handleListPredictionMarkets(args: unknown) {
  const { status } = PredictionMarketsSchema.parse(args);
  const url =
    status === "all"
      ? `${JUPITER_BASE}/prediction/v1/markets`
      : `${JUPITER_BASE}/prediction/v1/markets?status=${status}`;

  const data = await fetchJupiter(url);
  return {
    markets: data,
    _note:
      "Each market has: marketId, question, yesPrice (0-1), noPrice (0-1), " +
      "resolutionDate, totalVolume, liquidity, status. " +
      "Use yesPrice/noPrice as implied probabilities for signal generation.",
  };
}

async function handleGenerateBotCode(args: unknown) {
  const { strategy, params } = BotCodeSchema.parse(args);

  const templateDoc = DOCS.find(
    (d) => d.id === `bot_template_${strategy}` || d.keywords.includes(strategy)
  );

  const paramsBlock =
    params && Object.keys(params).length > 0
      ? `\n// ── Strategy Parameters ──\n// ${JSON.stringify(params, null, 2).replace(/\n/g, "\n// ")}\n`
      : "";

  const baseSchema = templateDoc?.schema ?? `// No template found for strategy: ${strategy}`;

  return {
    strategy,
    filename: `${strategy.replace(/_/g, "-")}-bot.ts`,
    code: `#!/usr/bin/env tsx
/**
 * Generated ${strategy.replace(/_/g, " ").toUpperCase()} Bot
 * Generated by: Jupiter MCP Server
 *
 * REQUIRED env vars:
 *   JUPITER_API_KEY       — from developers.jup.ag/portal
 *   JUPITER_BASE_URL      — https://api.jup.ag (default)
 *   SOLANA_RPC_URL        — your RPC endpoint
 *   SOLANA_KEY            — JSON array of wallet secret key bytes
 *   USER_WALLET_ADDRESS   — wallet public key
 *   SIMULATION_MODE       — true|false (default true)
 *
 * Install: npm install @solana/web3.js axios dotenv
 * Run:     npx tsx ${strategy.replace(/_/g, "-")}-bot.ts
 */
import { config } from "dotenv";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { Connection, Keypair, PublicKey, VersionedTransaction } from "@solana/web3.js";
import axios from "axios";

const __filename = fileURLToPath(import.meta.url);
const botDir = dirname(dirname(__filename));
config({ path: join(botDir, ".env") });

const JUPITER_BASE = process.env.JUPITER_BASE_URL ?? "https://api.jup.ag";
const JUPITER_HEADERS = { "x-api-key": process.env.JUPITER_API_KEY ?? "" };
const RPC_URL = process.env.SOLANA_RPC_URL ?? "https://api.mainnet-beta.solana.com";
const SIM_MODE = process.env.SIMULATION_MODE !== "false";

const connection = new Connection(RPC_URL, { commitment: "confirmed" });
const wallet = Keypair.fromSecretKey(
  new Uint8Array(JSON.parse(process.env.SOLANA_KEY ?? "[]"))
);

console.log("=== Bot Config ===");
console.log("Strategy:", "${strategy}");
console.log("Network:", process.env.SOLANA_RPC_URL);
console.log("Wallet:", wallet.publicKey.toBase58());
console.log("Simulation mode:", SIM_MODE);
console.log("Jupiter Base:", JUPITER_BASE);

${paramsBlock}

${baseSchema}

// ── Jupiter Swap V2 execution helper (Meta-Aggregator) ──
async function executeSwapV2(
  inputMint: string,
  outputMint: string,
  amount: bigint,
  userWallet: string
): Promise<string | null> {
  if (SIM_MODE) {
    console.log(\`[SIM] Would swap \${amount} \${inputMint.slice(0,8)}... → \${outputMint.slice(0,8)}...\`);
    return null;
  }
  // Step 1: Get order (all routers compete — best price)
  const orderRes = await axios.get(\`\${JUPITER_BASE}/swap/v2/order\`, {
    params: { inputMint, outputMint, amount: amount.toString(), taker: userWallet, slippageBps: 50 },
    headers: JUPITER_HEADERS,
    timeout: 15_000,
  });
  const { transaction, requestId } = orderRes.data;

  // Step 2: Sign
  const tx = VersionedTransaction.deserialize(Buffer.from(transaction, "base64"));
  tx.sign([wallet]);
  const signedTransaction = Buffer.from(tx.serialize()).toString("base64");

  // Step 3: Execute (Jupiter manages landing)
  const execRes = await axios.post(\`\${JUPITER_BASE}/swap/v2/execute\`, {
    signedTransaction, requestId,
  }, { headers: JUPITER_HEADERS, timeout: 30_000 });

  if (execRes.data.status === "Success") {
    console.log("✅ Swap executed:", execRes.data.signature);
    return execRes.data.signature;
  } else {
    console.error("❌ Swap failed:", execRes.data);
    return null;
  }
}

// ── Graceful shutdown ──
let intervalId: ReturnType<typeof setInterval> | null = null;
function shutdown(signal: string) {
  console.log(\`[\${signal}] Shutting down...\`);
  if (intervalId) clearInterval(intervalId);
  process.exit(0);
}
process.on("SIGINT",  () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
`,
    _instructions: [
      "1. Set JUPITER_API_KEY from developers.jup.ag/portal in your .env",
      "2. Set SOLANA_KEY as a JSON byte array, SOLANA_RPC_URL, USER_WALLET_ADDRESS",
      "3. Run: npm install @solana/web3.js axios dotenv && npx tsx src/index.ts",
      "4. All swaps use Swap V2 /order + /execute (best price, managed landing)",
      "5. Set SIMULATION_MODE=false when ready for live trading",
    ],
  };
}

// ─────────────────────────────────────────────
// Tool registry
// ─────────────────────────────────────────────

const TOOLS = [
  {
    name: "search_docs",
    description:
      "Search Jupiter API documentation across all products: Swap V2, Tokens, Price, Lend, " +
      "Trigger (limit orders), Recurring (DCA), Prediction Markets, Perps. " +
      "Call this FIRST before writing any Jupiter integration code.",
    inputSchema: {
      type: "object" as const,
      properties: {
        query: { type: "string", description: "e.g. 'OCO limit order', 'DCA recurring', 'flash loan arbitrage'" },
        include_examples: { type: "boolean", description: "Include code examples (default: true)" },
      },
      required: ["query"],
    },
  },
  {
    name: "get_order",
    description:
      "GET /swap/v2/order — Jupiter Swap V2 Meta-Aggregator. All routers compete for best price " +
      "(Metis + JupiterZ RFQ + Dflow + OKX). Returns base64 transaction + requestId for /execute. " +
      "Use this for most swap integrations.",
    inputSchema: {
      type: "object" as const,
      properties: {
        input_mint:   { type: "string", description: "Input token mint (base58)" },
        output_mint:  { type: "string", description: "Output token mint (base58)" },
        amount:       { type: "number", description: "Amount in base units" },
        taker:        { type: "string", description: "User wallet public key (base58)" },
        slippage_bps: { type: "number", description: "Slippage in bps (default: 50 = 0.5%)" },
      },
      required: ["input_mint", "output_mint", "amount", "taker"],
    },
  },
  {
    name: "get_build",
    description:
      "GET /swap/v2/build — Jupiter Swap V2 Router. Returns raw swap instructions for custom " +
      "transactions: CPI, composability, adding extra instructions. Metis-only routing. " +
      "Use when you need full transaction control.",
    inputSchema: {
      type: "object" as const,
      properties: {
        input_mint:   { type: "string", description: "Input token mint (base58)" },
        output_mint:  { type: "string", description: "Output token mint (base58)" },
        amount:       { type: "number", description: "Amount in base units" },
        taker:        { type: "string", description: "User wallet public key (base58)" },
        slippage_bps: { type: "number", description: "Slippage in bps (default: 50)" },
        max_accounts: { type: "number", description: "Max accounts in route (1-64, default 64)" },
        mode:         { type: "string", enum: ["fast", "default"], description: "Routing mode" },
      },
      required: ["input_mint", "output_mint", "amount", "taker"],
    },
  },
  {
    name: "get_token_info",
    description:
      "Tokens API V2 — fetch token metadata and safety assessment. Returns organicScore (0-100), " +
      "verifiedStatus, volume24h, holderCount, liquidity. " +
      "ALWAYS call this before generating a bot that trades an unfamiliar token.",
    inputSchema: {
      type: "object" as const,
      properties: {
        mint: { type: "string", description: "SPL token mint address (base58)" },
      },
      required: ["mint"],
    },
  },
  {
    name: "get_price",
    description:
      "Price API V2 — real-time USD prices for up to 100 Solana tokens. " +
      "Use for volatility detection, entry/exit thresholds, and P&L calculation.",
    inputSchema: {
      type: "object" as const,
      properties: {
        mints:    { type: "array", items: { type: "string" }, description: "Token mint addresses (1-100)" },
        vs_token: { type: "string", description: "Denominator token mint (default: USDC)" },
      },
      required: ["mints"],
    },
  },
  {
    name: "list_trigger_orders",
    description:
      "Trigger API V1 — list open limit/OCO/OTOCO orders for a wallet. " +
      "Check before placing new orders to avoid duplicates.",
    inputSchema: {
      type: "object" as const,
      properties: {
        wallet: { type: "string", description: "Wallet public key (base58)" },
      },
      required: ["wallet"],
    },
  },
  {
    name: "create_trigger_order",
    description:
      "Trigger API V1 — place a limit order. Supports: single (makingAmount/takingAmount), " +
      "OCO (take-profit + stop-loss), OTOCO (entry + TP/SL). " +
      "Returns a transaction to sign and send.",
    inputSchema: {
      type: "object" as const,
      properties: {
        input_mint:       { type: "string", description: "Sell token mint (base58)" },
        output_mint:      { type: "string", description: "Buy token mint (base58)" },
        making_amount:    { type: "string", description: "Input amount in base units (string)" },
        taking_amount:    { type: "string", description: "Min output amount in base units (string)" },
        user_public_key:  { type: "string", description: "Wallet public key (base58)" },
        order_type:       { type: "string", enum: ["single", "OCO", "OTOCO"], description: "Order type" },
        take_profit_rate: { type: "string", description: "e.g. '1.15' for +15% take profit (OCO/OTOCO)" },
        stop_loss_rate:   { type: "string", description: "e.g. '0.92' for -8% stop loss (OCO/OTOCO)" },
        entry_rate:       { type: "string", description: "Entry trigger rate (OTOCO only)" },
        expired_at:       { type: "number", description: "Unix timestamp expiry" },
      },
      required: ["input_mint", "output_mint", "making_amount", "taking_amount", "user_public_key"],
    },
  },
  {
    name: "list_recurring_orders",
    description:
      "Recurring API V1 — list active DCA orders for a wallet. " +
      "Shows cycle frequency, amountPerCycle, totalAmount, progress.",
    inputSchema: {
      type: "object" as const,
      properties: {
        wallet: { type: "string", description: "Wallet public key (base58)" },
      },
      required: ["wallet"],
    },
  },
  {
    name: "list_lend_markets",
    description:
      "Lend API V1 — list all lending markets with APY data. " +
      "Returns supplyAPY, borrowAPY, totalDeposits, utilizationRate. " +
      "Use for yield comparison in yield_sweeper strategies or flash loan arbitrage.",
    inputSchema: { type: "object" as const, properties: {}, required: [] },
  },
  {
    name: "list_perp_markets",
    description:
      "Perps API V1 — list available perpetual markets (SOL-PERP, BTC-PERP, ETH-PERP, etc.). " +
      "Returns oraclePrice, fundingRate, maxLeverage, openInterest. " +
      "Use before generating leveraged bot code.",
    inputSchema: { type: "object" as const, properties: {}, required: [] },
  },
  {
    name: "list_prediction_markets",
    description:
      "Prediction Markets V1 — list binary markets on real-world events. " +
      "Returns question, yesPrice (0-1), noPrice (0-1), totalVolume, resolutionDate. " +
      "Use yesPrice as implied probability for AI signal generation.",
    inputSchema: {
      type: "object" as const,
      properties: {
        status: { type: "string", enum: ["active", "resolved", "all"], description: "Market status filter" },
      },
      required: [],
    },
  },
  {
    name: "generate_bot_code",
    description:
      "Generate a complete TypeScript bot scaffold for a given strategy. " +
      "All generated bots use Swap V2 /order + /execute (not legacy V6). " +
      "Available strategies: copy_trade, safe_sniper, dca, arbitrage, yield_sweeper, " +
      "trigger_bot, prediction_arb, perps, flash_arb, adaptive_dca, event_driven.",
    inputSchema: {
      type: "object" as const,
      properties: {
        strategy: {
          type: "string",
          enum: [
            "copy_trade", "safe_sniper", "dca", "arbitrage", "yield_sweeper",
            "trigger_bot", "prediction_arb", "perps", "flash_arb", "adaptive_dca", "event_driven",
          ],
        },
        params: { type: "object", description: "Strategy parameters to embed in the template" },
      },
      required: ["strategy"],
    },
  },
] as const;

// ─────────────────────────────────────────────
// MCP Server bootstrap
// ─────────────────────────────────────────────

const server = new Server(
  { name: "jupiter-mcp", version: "2.0.0" },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: rawArgs } = request.params;

  try {
    let result: unknown;

    switch (name) {
      case "search_docs":           result = await handleSearchDocs(rawArgs); break;
      case "get_order":             result = await handleGetOrder(rawArgs); break;
      case "get_build":             result = await handleGetBuild(rawArgs); break;
      case "get_token_info":        result = await handleGetTokenInfo(rawArgs); break;
      case "get_price":             result = await handleGetPrice(rawArgs); break;
      case "list_trigger_orders":   result = await handleListTriggerOrders(rawArgs); break;
      case "create_trigger_order":  result = await handleCreateTriggerOrder(rawArgs); break;
      case "list_recurring_orders": result = await handleListRecurringOrders(rawArgs); break;
      case "list_lend_markets":     result = await handleListLendMarkets(); break;
      case "list_perp_markets":     result = await handleListPerpMarkets(); break;
      case "list_prediction_markets": result = await handleListPredictionMarkets(rawArgs); break;
      case "generate_bot_code":     result = await handleGenerateBotCode(rawArgs); break;
      default:
        throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${name}`);
    }

    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  } catch (err) {
    if (err instanceof z.ZodError) {
      throw new McpError(
        ErrorCode.InvalidParams,
        `Invalid arguments for "${name}": ${err.issues.map((e) => `${e.path.join(".")}: ${e.message}`).join("; ")}`
      );
    }
    if (err instanceof McpError) throw err;
    throw new McpError(
      ErrorCode.InternalError,
      `Tool "${name}" failed: ${(err as Error).message}`
    );
  }
});

// ─────────────────────────────────────────────
// Start
// ─────────────────────────────────────────────

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write(
    `[jupiter-mcp] Server ready — ${TOOLS.length} tools, ${DOCS.length} doc entries, base=${JUPITER_BASE}\n`
  );
}

main().catch((err) => {
  process.stderr.write(`[jupiter-mcp] Fatal startup error: ${err.message}\n`);
  process.exit(1);
});