#!/usr/bin/env node
/**
 * GoldRush MCP Server — Production
 *
 * Transport : Stdio (spawned as subprocess by the Python agent or any MCP host)
 * Purpose   : Read-only Solana on-chain data oracle via Covalent GoldRush API
 * Chain     : Hardcoded to solana-mainnet to prevent EVM hallucinations
 *
 * Tools exposed:
 *   get_token_balances       — SPL token balances + USD values for a wallet
 *   get_transactions         — Decoded transaction history for a wallet
 *   get_token_holders        — Top holders of an SPL token
 *   get_historical_portfolio — Historical portfolio value over time
 *   get_token_price          — Spot + OHLCV price data for a token
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

dotenv.config();

// ─────────────────────────────────────────────
// Config & validation
// ─────────────────────────────────────────────

const API_KEY = process.env.GOLDRUSH_API_KEY?.trim();
if (!API_KEY) {
  process.stderr.write(
    "[goldrush-mcp] FATAL: GOLDRUSH_API_KEY environment variable is missing.\n"
  );
  process.exit(1);
}

const BASE_URL = (
  process.env.GOLDRUSH_BASE_URL ?? "https://api.covalenthq.com/v1"
).replace(/\/+$/, "");

const CHAIN_ID = process.env.GOLDRUSH_NETWORK_ID ?? "solana-mainnet";
const TIMEOUT_MS = Number(process.env.GOLDRUSH_TIMEOUT_MS ?? 30_000);
const MAX_RETRIES = Number(process.env.GOLDRUSH_MAX_RETRIES ?? 3);

// ─────────────────────────────────────────────
// Zod input schemas
// ─────────────────────────────────────────────

const WalletSchema = z.object({
  wallet: z
    .string()
    .min(32)
    .max(44)
    .regex(/^[1-9A-HJ-NP-Za-km-z]+$/, "Must be a valid base58 Solana address"),
});

const TokenSchema = z.object({
  token_address: z
    .string()
    .min(32)
    .max(44)
    .regex(/^[1-9A-HJ-NP-Za-km-z]+$/, "Must be a valid base58 SPL token mint address"),
});

const TransactionsSchema = WalletSchema.extend({
  page: z.number().int().min(0).optional().default(0),
  page_size: z.number().int().min(1).max(100).optional().default(25),
});

const HoldersSchema = TokenSchema.extend({
  page_size: z.number().int().min(1).max(100).optional().default(25),
});

const HistoricalSchema = WalletSchema.extend({
  days: z.number().int().min(1).max(365).optional().default(30),
});

const PriceSchema = TokenSchema.extend({
  from: z.string().optional().describe("ISO date string e.g. 2024-01-01"),
  to: z.string().optional().describe("ISO date string e.g. 2024-12-31"),
});

// ─────────────────────────────────────────────
// HTTP helper with retry + timeout
// ─────────────────────────────────────────────

async function fetchGoldRush(
  endpoint: string,
  params: Record<string, string | number> = {}
): Promise<unknown> {
  const url = new URL(`${BASE_URL}${endpoint}`);
  for (const [k, v] of Object.entries(params)) {
    url.searchParams.set(k, String(v));
  }

  let lastError: Error | null = null;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

    try {
      const res = await fetch(url.toString(), {
        headers: {
          Authorization: `Bearer ${API_KEY}`,
          "Content-Type": "application/json",
        },
        signal: controller.signal,
      });

      clearTimeout(timer);

      // Rate-limit: back off and retry
      if (res.status === 429) {
        const retryAfter = Number(res.headers.get("Retry-After") ?? 2);
        process.stderr.write(
          `[goldrush-mcp] 429 rate-limited — waiting ${retryAfter}s (attempt ${attempt}/${MAX_RETRIES})\n`
        );
        await sleep(retryAfter * 1000);
        continue;
      }

      // Transient server errors
      if (res.status >= 500 && attempt < MAX_RETRIES) {
        process.stderr.write(
          `[goldrush-mcp] HTTP ${res.status} — retrying (attempt ${attempt}/${MAX_RETRIES})\n`
        );
        await sleep(500 * attempt);
        continue;
      }

      if (!res.ok) {
        const body = await res.text().catch(() => "(unreadable body)");
        throw new Error(`HTTP ${res.status} ${res.statusText}: ${body}`);
      }

      const json = (await res.json()) as { data?: unknown; error?: boolean; error_message?: string };

      if (json.error) {
        throw new Error(`GoldRush API error: ${json.error_message ?? "unknown"}`);
      }

      return json.data;
    } catch (err) {
      clearTimeout(timer);
      if ((err as Error).name === "AbortError") {
        lastError = new Error(`Request timed out after ${TIMEOUT_MS}ms`);
      } else {
        lastError = err as Error;
      }

      if (attempt < MAX_RETRIES) {
        await sleep(300 * attempt);
      }
    }
  }

  throw lastError ?? new Error("Unknown fetch error");
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ─────────────────────────────────────────────
// Tool registry
// ─────────────────────────────────────────────

const TOOLS = [
  {
    name: "get_token_balances",
    description:
      "Fetch current SPL token balances with exact fiat USD values for a Solana wallet. " +
      "Use this to understand what a wallet currently holds before writing strategy logic.",
    inputSchema: {
      type: "object" as const,
      properties: {
        wallet: {
          type: "string",
          description: "Base58-encoded Solana wallet address (32–44 chars)",
        },
      },
      required: ["wallet"],
    },
  },
  {
    name: "get_transactions",
    description:
      "Fetch decoded transaction history (swaps, transfers, staking) for a Solana wallet. " +
      "Use this to understand a wallet's trading behaviour or to copy-trade strategy logic.",
    inputSchema: {
      type: "object" as const,
      properties: {
        wallet: {
          type: "string",
          description: "Base58-encoded Solana wallet address",
        },
        page: {
          type: "number",
          description: "Zero-based page index (default 0)",
        },
        page_size: {
          type: "number",
          description: "Transactions per page, 1–100 (default 25)",
        },
      },
      required: ["wallet"],
    },
  },
  {
    name: "get_token_holders",
    description:
      "Fetch the top holders of an SPL token mint. " +
      "Use this to assess concentration risk or identify whale wallets worth tracking.",
    inputSchema: {
      type: "object" as const,
      properties: {
        token_address: {
          type: "string",
          description: "Base58-encoded SPL token mint address",
        },
        page_size: {
          type: "number",
          description: "Number of holders to return, 1–100 (default 25)",
        },
      },
      required: ["token_address"],
    },
  },
  {
    name: "get_historical_portfolio",
    description:
      "Fetch the historical USD portfolio value for a Solana wallet over N days. " +
      "Use this to backtest or validate a strategy before generating bot code.",
    inputSchema: {
      type: "object" as const,
      properties: {
        wallet: {
          type: "string",
          description: "Base58-encoded Solana wallet address",
        },
        days: {
          type: "number",
          description: "Look-back window in days, 1–365 (default 30)",
        },
      },
      required: ["wallet"],
    },
  },
  {
    name: "get_token_price",
    description:
      "Fetch spot price and OHLCV candle data for an SPL token. " +
      "Use this to set entry/exit thresholds in generated trading bots.",
    inputSchema: {
      type: "object" as const,
      properties: {
        token_address: {
          type: "string",
          description: "Base58-encoded SPL token mint address",
        },
        from: {
          type: "string",
          description: "Start date ISO string, e.g. 2024-01-01 (optional)",
        },
        to: {
          type: "string",
          description: "End date ISO string, e.g. 2024-12-31 (optional)",
        },
      },
      required: ["token_address"],
    },
  },
] as const;

// ─────────────────────────────────────────────
// Tool handlers
// ─────────────────────────────────────────────

async function handleGetTokenBalances(args: unknown) {
  const { wallet } = WalletSchema.parse(args);
  const data = await fetchGoldRush(
    `/${CHAIN_ID}/address/${encodeURIComponent(wallet)}/balances_v2/`
  );
  return data;
}

async function handleGetTransactions(args: unknown) {
  const { wallet, page, page_size } = TransactionsSchema.parse(args);
  const data = await fetchGoldRush(
    `/${CHAIN_ID}/address/${encodeURIComponent(wallet)}/transactions_v3/`,
    { "page-number": page, "page-size": page_size }
  );
  return data;
}

async function handleGetTokenHolders(args: unknown) {
  const { token_address, page_size } = HoldersSchema.parse(args);
  const data = await fetchGoldRush(
    `/${CHAIN_ID}/tokens/${encodeURIComponent(token_address)}/token_holders_v2/`,
    { "page-size": page_size }
  );
  return data;
}

async function handleGetHistoricalPortfolio(args: unknown) {
  const { wallet, days } = HistoricalSchema.parse(args);
  const data = await fetchGoldRush(
    `/${CHAIN_ID}/address/${encodeURIComponent(wallet)}/portfolio_v2/`,
    { days }
  );
  return data;
}

async function handleGetTokenPrice(args: unknown) {
  const { token_address, from, to } = PriceSchema.parse(args);
  const params: Record<string, string | number> = {};
  if (from) params["from"] = from;
  if (to) params["to"] = to;
  const data = await fetchGoldRush(
    `/pricing/historical_by_addresses_v2/${CHAIN_ID}/USD/${encodeURIComponent(token_address)}/`,
    params
  );
  return data;
}

// ─────────────────────────────────────────────
// MCP Server bootstrap
// ─────────────────────────────────────────────

const server = new Server(
  { name: "goldrush-solana-mcp", version: "1.0.0" },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: rawArgs } = request.params;

  try {
    let result: unknown;

    switch (name) {
      case "get_token_balances":
        result = await handleGetTokenBalances(rawArgs);
        break;
      case "get_transactions":
        result = await handleGetTransactions(rawArgs);
        break;
      case "get_token_holders":
        result = await handleGetTokenHolders(rawArgs);
        break;
      case "get_historical_portfolio":
        result = await handleGetHistoricalPortfolio(rawArgs);
        break;
      case "get_token_price":
        result = await handleGetTokenPrice(rawArgs);
        break;
      default:
        throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${name}`);
    }

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(result, null, 2),
        },
      ],
    };
  } catch (err) {
    // Zod validation errors → InvalidParams
    if (err instanceof z.ZodError) {
      throw new McpError(
        ErrorCode.InvalidParams,
        `Invalid arguments for tool "${name}": ${err.errors
          .map((e) => `${e.path.join(".")}: ${e.message}`)
          .join("; ")}`
      );
    }

    // Re-throw MCP errors unchanged
    if (err instanceof McpError) throw err;

    // Wrap generic errors
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
    `[goldrush-mcp] Server ready — chain: ${CHAIN_ID}, base: ${BASE_URL}\n`
  );
}

main().catch((err) => {
  process.stderr.write(`[goldrush-mcp] Fatal startup error: ${err.message}\n`);
  process.exit(1);
});