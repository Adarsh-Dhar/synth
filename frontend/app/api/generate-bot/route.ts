import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { encryptEnvConfig } from "@/lib/crypto-env";
import { assembleBotFiles, assembleSolanaBotFiles } from "../get-bot-code/bot-files";
import { sanitizeIntentMcpLists, shouldUseLegacyDeterministicFallback } from "@/lib/intent/mcp-sanitizer";
import type { Prisma } from "@/lib/generated/prisma/client.ts";
import { requireWalletAuth } from "@/lib/auth/server";
import fs from "node:fs";
import path from "node:path";

const META_AGENT_URL = process.env.META_AGENT_URL ?? "http://127.0.0.1:8000";
const HEALTH_TIMEOUT_MS = Number(process.env.META_AGENT_HEALTH_TIMEOUT_MS ?? "2000");
const HEALTH_RETRIES = Number(process.env.META_AGENT_HEALTH_RETRIES ?? "2");
const META_TIMEOUT_MS = Number(process.env.META_AGENT_GENERATE_TIMEOUT_MS ?? "240000");
const META_RETRIES = Number(process.env.META_AGENT_GENERATE_RETRIES ?? "1");
const MAX_META_PROMPT_CHARS = Number(process.env.MAX_META_PROMPT_CHARS ?? "1800");

type GeneratedFile = { filepath: string; content: unknown; language?: string };

function compactPromptForMetaAgent(input: string): { prompt: string; truncated: boolean } {
  const normalized = input.replace(/\r/g, "").trim();
  if (normalized.length <= MAX_META_PROMPT_CHARS) return { prompt: normalized, truncated: false };

  const head = Math.floor(MAX_META_PROMPT_CHARS * 0.7);
  const tail = Math.max(300, MAX_META_PROMPT_CHARS - head - 64);
  return {
    prompt: `${normalized.slice(0, head)}\n\n[...truncated for model limit...]\n\n${normalized.slice(-tail)}`,
    truncated: true,
  };
}

function parseEnvText(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    const commentIndex = value.indexOf(" #");
    if (commentIndex >= 0) value = value.slice(0, commentIndex).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (key) out[key] = value;
  }
  return out;
}

function buildSafeYieldSweeperIndexTs(): string {
  return [
    'import "dotenv/config";',
    'import { callMcpTool, getFaBalance } from "./mcp_bridge.js";',
    '',
    'const POLL_MS = Number(process.env.POLL_MS ?? 15000);',
    'const SWEEP_THRESHOLD = BigInt(String(process.env.SWEEP_THRESHOLD_UUSDC ?? "1000000"));',
    '',
    'function log(level: string, message: string): void {',
    '  console.log("[" + new Date().toISOString() + "] [" + level + "] " + message);',
    '}',
    '',
    'async function sweepCycle(): Promise<void> {',
    '  try {',
    '    const wallet = String(process.env.USER_WALLET_ADDRESS ?? "").trim();',
    '    if (!wallet) { log("WARN", "USER_WALLET_ADDRESS not set"); return; }',
    '    const metadata = String(process.env.SOLANA_USDC_METADATA_ADDRESS ?? "").trim();',
    '    const bal = await getFaBalance(String(process.env.SOLANA_NETWORK ?? "mainnet-beta"), wallet, metadata);',
    '    log("INFO", "Balance (raw): " + String(bal));',
    '    // placeholder: implement sweep logic as needed',
    '  } catch (err) {',
    '    const msg = err instanceof Error ? err.message : String(err);',
    '    log("ERROR", msg);',
    '  }',
    '}',
    '',
    'setInterval(() => { void sweepCycle(); }, POLL_MS);',
    ''
  ].join("\n");
}

function buildSafeSpreadScannerIndexTs(): string {
  return [
    'import "dotenv/config";',
    'import { callMcpTool } from "./mcp_bridge.js";',
    '',
    'const POLL_MS = Number(process.env.POLL_MS ?? 15000);',
    'const ESTIMATED_BRIDGE_FEE_USDC = BigInt(process.env.ESTIMATED_BRIDGE_FEE_USDC ?? 5000n);',
    'const EXECUTION_AMOUNT_USDC = BigInt(process.env.SOLANA_EXECUTION_AMOUNT_USDC ?? process.env.SOLANA_EXECUTION_AMOUNT_USDC ?? process.env.SOLANA_EXECUTION_AMOUNT_USDC ?? process.env.SOLANA_EXECUTION_AMOUNT_USDC ?? 1000000n);',
    'const PRICE_VIEW_ADDRESS = String(process.env.SOLANA_PRICE_VIEW_ADDRESS ?? process.env.SOLANA_PRICE_VIEW_ADDRESS ?? process.env.SOLANA_PRICE_VIEW_ADDRESS ?? process.env.SOLANA_PRICE_VIEW_ADDRESS ?? "0x1").trim();',
    'const PRICE_VIEW_MODULE = String(process.env.SOLANA_PRICE_VIEW_MODULE ?? process.env.SOLANA_PRICE_VIEW_MODULE ?? process.env.SOLANA_PRICE_VIEW_MODULE ?? process.env.SOLANA_PRICE_VIEW_MODULE ?? "dex").trim();',
    'const PRICE_VIEW_FUNCTION = String(process.env.SOLANA_PRICE_VIEW_FUNCTION ?? process.env.SOLANA_PRICE_VIEW_FUNCTION ?? process.env.SOLANA_PRICE_VIEW_FUNCTION ?? process.env.SOLANA_PRICE_VIEW_FUNCTION ?? "get_amount_out").trim();',
    'const USDC_COIN_TYPE = String(process.env.SOLANA_USDC_METADATA_ADDRESS ?? process.env.SOLANA_USDC_METADATA_ADDRESS ?? process.env.SOLANA_USDC_METADATA_ADDRESS ?? process.env.SOLANA_USDC_METADATA_ADDRESS ?? "0x1::coin::uinit").trim();',
    'const typeArgsRaw = String(process.env.SOLANA_PRICE_VIEW_TYPE_ARGS ?? process.env.SOLANA_PRICE_VIEW_TYPE_ARGS ?? process.env.SOLANA_PRICE_VIEW_TYPE_ARGS ?? process.env.SOLANA_PRICE_VIEW_TYPE_ARGS || ("0x1::coin::uinit," + USDC_COIN_TYPE));',
    'const PRICE_VIEW_TYPE_ARGS = typeArgsRaw.split(",").map((part) => part.trim()).filter(Boolean);',
    'const PRICE_VIEW_ARGS_TEMPLATE = String(process.env.SOLANA_PRICE_VIEW_ARGS ?? process.env.SOLANA_PRICE_VIEW_ARGS ?? process.env.SOLANA_PRICE_VIEW_ARGS ?? process.env.SOLANA_PRICE_VIEW_ARGS ?? "$endpoint,$amount").trim();',
    'const ARBITRAGE_ROUTER_ADDRESS = String(process.env.SOLANA_SWAP_ROUTER_ADDRESS ?? process.env.SOLANA_SWAP_ROUTER_ADDRESS ?? process.env.SOLANA_SWAP_ROUTER_ADDRESS ?? process.env.SOLANA_SWAP_ROUTER_ADDRESS ?? "").trim();',
    'const ARBITRAGE_ROUTER_MODULE = String(process.env.SOLANA_SWAP_ROUTER_MODULE ?? process.env.SOLANA_SWAP_ROUTER_MODULE ?? process.env.SOLANA_SWAP_ROUTER_MODULE ?? process.env.SOLANA_SWAP_ROUTER_MODULE ?? process.env.SOLANA_SWAP_MODULE ?? process.env.SOLANA_SWAP_MODULE ?? process.env.SOLANA_SWAP_MODULE ?? process.env.SOLANA_SWAP_MODULE ?? "arbitrage_router").trim();',
    'const ARBITRAGE_ROUTER_FUNCTION = String(process.env.SOLANA_SWAP_ROUTER_FUNCTION ?? process.env.SOLANA_SWAP_ROUTER_FUNCTION ?? process.env.SOLANA_SWAP_ROUTER_FUNCTION ?? process.env.SOLANA_SWAP_ROUTER_FUNCTION ?? process.env.SOLANA_SWAP_FUNCTION ?? process.env.SOLANA_SWAP_FUNCTION ?? process.env.SOLANA_SWAP_FUNCTION ?? process.env.SOLANA_SWAP_FUNCTION ?? "execute_cross_chain_trade").trim();',
    'const ARBITRAGE_ROUTER_TYPE_ARGS = String(process.env.SOLANA_SWAP_TYPE_ARGS ?? process.env.SOLANA_SWAP_TYPE_ARGS ?? process.env.SOLANA_SWAP_TYPE_ARGS ?? process.env.SOLANA_SWAP_TYPE_ARGS ?? "").split(",").map((part) => part.trim()).filter(Boolean);',
    'const ARBITRAGE_ROUTER_ARGS_TEMPLATE = String(process.env.SOLANA_SWAP_ROUTER_ARGS ?? process.env.SOLANA_SWAP_ROUTER_ARGS ?? process.env.SOLANA_SWAP_ROUTER_ARGS ?? process.env.SOLANA_SWAP_ROUTER_ARGS ?? process.env.SOLANA_SWAP_ARGS ?? process.env.SOLANA_SWAP_ARGS ?? process.env.SOLANA_SWAP_ARGS ?? process.env.SOLANA_SWAP_ARGS ?? "$buyEndpoint,$sellEndpoint,$amount").trim();',
    'const ALLOW_COMPATIBILITY_QUOTES = String(process.env.ALLOW_COMPATIBILITY_QUOTES ?? "false").trim().toLowerCase() === "true";',
    '',
    'function requireConfiguredAddress(name: string, value: unknown): string {',
    '  const resolved = String(value ?? "").trim();',
    '  if (!resolved) throw new Error(name + " is not set");',
    '  return resolved;',
    '}',
    '',
    'const poolAAddress = requireConfiguredAddress("SOLANA_POOL_A_ADDRESS", process.env.SOLANA_POOL_A_ADDRESS ?? process.env.SOLANA_POOL_A_ADDRESS ?? process.env.SOLANA_POOL_A_ADDRESS ?? process.env.SOLANA_POOL_A_ADDRESS);',
    'const poolBAddress = requireConfiguredAddress("SOLANA_POOL_B_ADDRESS", process.env.SOLANA_POOL_B_ADDRESS ?? process.env.SOLANA_POOL_B_ADDRESS ?? process.env.SOLANA_POOL_B_ADDRESS ?? process.env.SOLANA_POOL_B_ADDRESS);',
    'const ENDPOINTS = [',
    '  { id: "pool-a", address: poolAAddress },',
    '  { id: "pool-b", address: poolBAddress },',
    '];',
    '',
    'function log(level: string, message: string): void {',
    '  console.log("[" + new Date().toISOString() + "] [" + level + "] " + message);',
    '}',
    '',
    'function toBigInt(value: unknown): bigint | null {',
    '  if (typeof value === "bigint") return value;',
    '  if (typeof value === "number" && Number.isFinite(value)) return BigInt(Math.trunc(value));',
    '  if (typeof value === "string") {',
    '    const trimmed = value.trim();',
    '    if (!trimmed) return null;',
    '    if (!/^[0-9]+$/.test(trimmed)) return null;',
    '    try { return BigInt(trimmed); } catch { return null; }',
    '  }',
    '  return null;',
    '}',
    '',
    'function extractPrice(payload: unknown): bigint | null {',
    '  if (payload && typeof payload === "object") {',
    '    const root = payload as Record<string, unknown>;',
    '    const direct = toBigInt(root.balance ?? root.amount ?? root.value ?? root.coin_amount);',
    '    if (direct !== null) return direct;',
    '    const result = root.result && typeof root.result === "object" ? (root.result as Record<string, unknown>) : null;',
    '    if (result) {',
    '      const nested = toBigInt(result.balance ?? result.amount ?? result.value ?? result.coin_amount);',
    '      if (nested !== null) return nested;',
    '    }',
    '  }',
    '  return null;',
    '}',
    '',
    'function isCompatibilityQuote(payload: unknown): boolean {',
    '  if (!payload || typeof payload !== "object") return false;',
    '  const root = payload as Record<string, unknown>;',
    '  const result = root.result && typeof root.result === "object" ? (root.result as Record<string, unknown>) : null;',
    '  const sourceFunction = root.source_function ?? root.sourceFunction ?? result?.source_function ?? result?.sourceFunction;',
    '  return typeof sourceFunction === "string" && sourceFunction === "dex.get_pool_info";',
    '}',
    '',
    'function extractTxHash(payload: unknown): string | null {',
    '  const pick = (value: unknown): string | null => {',
    '    if (!value || typeof value !== "object") return null;',
    '    const obj = value as Record<string, unknown>;',
    '    const direct = obj.txHash ?? obj.tx_hash ?? obj.hash ?? obj.transaction_hash;',
    '    if (typeof direct === "string" && direct.trim()) return direct.trim();',
    '    return null;',
    '  };',
    '',
    '  const parseJsonText = (text: string): unknown => {',
    '    try {',
    '      return JSON.parse(text);',
    '    } catch {',
    '      return null;',
    '    }',
    '  };',
    '',
    '  const walk = (value: unknown): string | null => {',
    '    const direct = pick(value);',
    '    if (direct) return direct;',
    '    if (!value || typeof value !== "object") return null;',
    '    const obj = value as Record<string, unknown>;',
    '',
    '    if (typeof obj.text === "string" && obj.text.trim()) {',
    '      const parsed = parseJsonText(obj.text);',
    '      const fromText = walk(parsed);',
    '      if (fromText) return fromText;',
    '    }',
    '',
    '    const nestedResult = obj.result;',
    '    if (nestedResult) {',
    '      const fromResult = walk(nestedResult);',
    '      if (fromResult) return fromResult;',
    '    }',
    '',
    '    const content = Array.isArray(obj.content) ? obj.content : null;',
    '    if (content) {',
    '      for (const entry of content) {',
    '        const fromEntry = walk(entry);',
    '        if (fromEntry) return fromEntry;',
    '      }',
    '    }',
    '',
    '    return null;',
    '  };',
    '',
    '  return walk(payload);',
    '}',
    '',
    'function formatForLog(value: unknown): string {',
    '  try {',
    '    return JSON.stringify(value, (_key, current) => (typeof current === "bigint" ? current.toString() : current));',
    '  } catch {',
    '    try {',
    '      return String(value);',
    '    } catch {',
    '      return "<unserializable>";',
    '    }',
    '  }',
    '}',
    '',
    'async function safeMcp(server: string, tool: string, args: Record<string, unknown>): Promise<unknown | null> {',
    '  try {',
    '    return await callMcpTool(server, tool, args);',
    '  } catch (error) {',
    '    const msg = error instanceof Error ? error.message : String(error);',
    '    log("WARN", "MCP " + server + "/" + tool + " unavailable: " + msg);',
    '    return null;',
    '  }',
    '}',
    '',
    'function buildArbitrageArgs(buyEndpointAddress: string, sellEndpointAddress: string): string[] {',
    '  const usdcMetadata = String(process.env.SOLANA_USDC_METADATA_ADDRESS ?? process.env.SOLANA_USDC_METADATA_ADDRESS ?? process.env.SOLANA_USDC_METADATA_ADDRESS ?? process.env.SOLANA_USDC_METADATA_ADDRESS ?? "").trim();',
    '  if (!ARBITRAGE_ROUTER_ARGS_TEMPLATE) return [buyEndpointAddress, sellEndpointAddress, EXECUTION_AMOUNT_USDC.toString(), usdcMetadata].filter(Boolean);',
    '  return ARBITRAGE_ROUTER_ARGS_TEMPLATE',
    '    .split(",")',
    '    .map((part) => part.trim())',
    '    .filter(Boolean)',
    '    .map((part) => {',
    '      if (part === "$buyEndpoint") return buyEndpointAddress;',
    '      if (part === "$sellEndpoint") return sellEndpointAddress;',
    '      if (part === "$amount") return EXECUTION_AMOUNT_USDC.toString();',
    '      if (part === "$usdcMetadata") return usdcMetadata;',
    '      return part;',
    '    });',
    '}',
    '',
    'async function executeArbitrage(buyEndpointAddress: string, sellEndpointAddress: string, expectedProfit: bigint): Promise<void> {',
    '  const missing: string[] = [];',
    '  if (!ARBITRAGE_ROUTER_ADDRESS) missing.push("SOLANA_SWAP_ROUTER_ADDRESS");',
    '  if (!ARBITRAGE_ROUTER_MODULE) missing.push("SOLANA_SWAP_ROUTER_MODULE");',
    '  if (!ARBITRAGE_ROUTER_FUNCTION) missing.push("SOLANA_SWAP_ROUTER_FUNCTION");',
    '  if (missing.length > 0) {',
    '    log("WARN", "Profitable spread detected but execution config is incomplete (missing: " + missing.join(",") + "); skipping execution");',
    '    return;',
    '  }',
    '  log("INFO", "[EXECUTE] buy=" + buyEndpointAddress + " sell=" + sellEndpointAddress + " amount=" + EXECUTION_AMOUNT_USDC.toString() + " expectedProfit=" + expectedProfit.toString());',
    '  const result = await safeMcp("solana", "move_execute", {',
    '    network: String(process.env.SOLANA_NETWORK ?? process.env.SOLANA_NETWORK ?? process.env.SOLANA_NETWORK ?? process.env.SOLANA_NETWORK ?? "mainnet-beta"),',
    '    address: ARBITRAGE_ROUTER_ADDRESS,',
    '    module: ARBITRAGE_ROUTER_MODULE,',
    '    function: ARBITRAGE_ROUTER_FUNCTION,',
    '    type_args: ARBITRAGE_ROUTER_TYPE_ARGS,',
    '    args: buildArbitrageArgs(buyEndpointAddress, sellEndpointAddress),',
    '  });',
    '  if (result) {',
    '    log("INFO", "[EXECUTE_RESULT] " + formatForLog(result));',
    '    const txHash = extractTxHash(result);',
    '    if (txHash) {',
    '      log("INFO", "[SUCCESS] Arbitrage transaction submitted txHash=" + txHash);',
    '      return;',
    '    }',
    '    log("INFO", "[SUCCESS] Arbitrage transaction submitted (tx hash unavailable in response; see [EXECUTE_RESULT])");',
    '    return;',
    '  }',
    '  log("WARN", "[FAILED] Arbitrage execution returned no result");',
    '}',
    '',
    'function buildPriceViewArgs(endpointAddress: string, amountIn: bigint): string[] {',
    '  const amount = amountIn.toString();',
    '  if (!PRICE_VIEW_ARGS_TEMPLATE) return [endpointAddress, amount];',
    '  const resolved = PRICE_VIEW_ARGS_TEMPLATE',
    '    .split(",")',
    '    .map((part) => part.trim())',
    '    .filter(Boolean)',
    '    .map((part) => {',
    '      if (part === "$endpoint") return endpointAddress;',
    '      if (part === "$amount") return amount;',
    '      return part;',
    '    });',
    '  if (resolved.length === 0) return [endpointAddress, amount];',
    '  if (resolved.length === 1) {',
    '    const only = resolved[0];',
    '    if (only === endpointAddress || /^0x[0-9a-f]+$/i.test(only) || /^init1[0-9a-z]+$/i.test(only)) {',
    '      return [only, amount];',
    '    }',
    '    return [endpointAddress, only];',
    '  }',
    '  if (String(PRICE_VIEW_FUNCTION).toLowerCase() === "get_amount_out") {',
    '    const candidateAddress = resolved.find((part) => /^0x[0-9a-f]+$/i.test(part) || /^init1[0-9a-z]+$/i.test(part));',
    '    return [candidateAddress ?? endpointAddress, amount];',
    '  }',
    '  return resolved;',
    '}',
    '',
    'async function runCycle(): Promise<void> {',
    '  log("INFO", "Spread scan cycle start");',
    '  if (!PRICE_VIEW_ADDRESS || !PRICE_VIEW_MODULE || !PRICE_VIEW_FUNCTION) {',
    '    log("WARN", "Set SOLANA_PRICE_VIEW_ADDRESS, SOLANA_PRICE_VIEW_MODULE, and SOLANA_PRICE_VIEW_FUNCTION for spread quotes");',
    '    return;',
    '  }',
    '  let usedCompatibilityQuote = false;',
    '  const buyQuotes = await Promise.allSettled(',
    '    ENDPOINTS.map((endpoint) => safeMcp("solana", "move_view", {',
    '      network: String(process.env.SOLANA_NETWORK ?? process.env.SOLANA_NETWORK ?? process.env.SOLANA_NETWORK ?? process.env.SOLANA_NETWORK ?? "mainnet-beta"),',
    '      address: PRICE_VIEW_ADDRESS,',
    '      module: PRICE_VIEW_MODULE,',
    '      function: PRICE_VIEW_FUNCTION,',
    '      type_args: PRICE_VIEW_TYPE_ARGS,',
    '      args: buildPriceViewArgs(endpoint.address, EXECUTION_AMOUNT_USDC),',
    '    }).then((payload) => ({ endpoint, payload })))',
    '  );',
    '',
    '  const buyLegs: Array<{ id: string; address: string; amountOut: bigint }> = [];',
    '  for (const settled of buyQuotes) {',
    '    if (settled.status !== "fulfilled") {',
    '      const msg = settled.reason instanceof Error ? settled.reason.message : String(settled.reason);',
    '      log("WARN", "Buy quote failed: " + msg);',
    '      continue;',
    '    }',
    '    const { endpoint, payload } = settled.value;',
    '    const amountOut = extractPrice(payload);',
    '    if (amountOut === null) {',
    '      log("WARN", "[SCAN] buy " + endpoint.id + " returned non-numeric payload");',
    '      continue;',
    '    }',
    '    usedCompatibilityQuote = usedCompatibilityQuote || isCompatibilityQuote(payload);',
    '    buyLegs.push({ id: endpoint.id, address: endpoint.address, amountOut });',
    '    log("INFO", "[SCAN] buy " + endpoint.id + " amount_out=" + amountOut.toString());',
    '  }',
    '',
    '  if (buyLegs.length < 1) {',
    '    log("WARN", "No valid buy quote returned");',
    '    return;',
    '  }',
    '',
    '  const bestBuy = buyLegs.reduce((best, current) => (current.amountOut > best.amountOut ? current : best), buyLegs[0]);',
    '  const fallbackSellTypeArgs = PRICE_VIEW_TYPE_ARGS.length >= 2 ? [PRICE_VIEW_TYPE_ARGS[1], PRICE_VIEW_TYPE_ARGS[0]] : PRICE_VIEW_TYPE_ARGS;',
    '  const sellTypeArgs = String(process.env.SOLANA_SELL_VIEW_TYPE_ARGS ?? process.env.SOLANA_SELL_VIEW_TYPE_ARGS ?? process.env.SOLANA_SELL_VIEW_TYPE_ARGS ?? process.env.SOLANA_SELL_VIEW_TYPE_ARGS ?? "").split(",").map((part) => part.trim()).filter(Boolean);',
    '  const activeSellTypeArgs = sellTypeArgs.length > 0 ? sellTypeArgs : fallbackSellTypeArgs;',
    '',
    '  const sellQuotes = await Promise.allSettled(',
    '    ENDPOINTS',
    '      .filter((endpoint) => endpoint.address !== bestBuy.address)',
    '      .map((endpoint) => safeMcp("solana", "move_view", {',
    '        network: String(process.env.SOLANA_NETWORK ?? process.env.SOLANA_NETWORK ?? process.env.SOLANA_NETWORK ?? process.env.SOLANA_NETWORK ?? "mainnet-beta"),',
    '        address: PRICE_VIEW_ADDRESS,',
    '        module: PRICE_VIEW_MODULE,',
    '        function: PRICE_VIEW_FUNCTION,',
    '        type_args: activeSellTypeArgs,',
    '        args: buildPriceViewArgs(endpoint.address, bestBuy.amountOut),',
    '      }).then((payload) => ({ endpoint, payload })))',
    '  );',
    '',
    '  const sellLegs: Array<{ id: string; address: string; amountOut: bigint }> = [];',
    '  for (const settled of sellQuotes) {',
    '    if (settled.status !== "fulfilled") {',
    '      const msg = settled.reason instanceof Error ? settled.reason.message : String(settled.reason);',
    '      log("WARN", "Sell quote failed: " + msg);',
    '      continue;',
    '    }',
    '    const { endpoint, payload } = settled.value;',
    '    const amountOut = extractPrice(payload);',
    '    if (amountOut === null) {',
    '      log("WARN", "[SCAN] sell " + endpoint.id + " returned non-numeric payload");',
    '      continue;',
    '    }',
    '    usedCompatibilityQuote = usedCompatibilityQuote || isCompatibilityQuote(payload);',
    '    sellLegs.push({ id: endpoint.id, address: endpoint.address, amountOut });',
    '    log("INFO", "[SCAN] sell " + endpoint.id + " amount_out=" + amountOut.toString());',
    '  }',
    '',
    '  if (sellLegs.length < 1) {',
    '    log("WARN", "No valid sell quote returned");',
    '    return;',
    '  }',
    '',
    '  const bestSell = sellLegs.reduce((best, current) => (current.amountOut > best.amountOut ? current : best), sellLegs[0]);',
    '  const grossSpread = bestSell.amountOut > EXECUTION_AMOUNT_USDC ? bestSell.amountOut - EXECUTION_AMOUNT_USDC : 0n;',
    '  const netOpportunity = grossSpread > ESTIMATED_BRIDGE_FEE_USDC ? grossSpread - ESTIMATED_BRIDGE_FEE_USDC : 0n;',
    '  if (usedCompatibilityQuote && !ALLOW_COMPATIBILITY_QUOTES) {',
    '    log("WARN", "[SKIP] Quote came from the dex.get_pool_info compatibility shim, so execution is disabled until a native quote view is configured");',
    '    return;',
    '  }',
    '  if (usedCompatibilityQuote && ALLOW_COMPATIBILITY_QUOTES) {',
    '    log("WARN", "[UNSAFE] Executing based on compatibility quote source dex.get_pool_info because ALLOW_COMPATIBILITY_QUOTES=true");',
    '  }',
    '  if (netOpportunity > 0n) {',
    '    log("INFO", "[ACTION] Profitable spread found. Executing trade path...");',
    '    await executeArbitrage(bestBuy.address, bestSell.address, netOpportunity);',
    '    return;',
    '  }',
    '  log("INFO", "[QUANTIFY] gross=" + grossSpread.toString() + " fee=" + ESTIMATED_BRIDGE_FEE_USDC.toString() + " net=" + netOpportunity.toString() + " (No action taken)");',
    '}',
    '',
    'let inFlight = false;',
    'let timer: ReturnType<typeof setTimeout> | null = null;',
    '',
    'async function tick(): Promise<void> {',
    '  if (inFlight) return;',
    '  inFlight = true;',
    '  try {',
    '    await runCycle();',
    '  } catch (error) {',
    '    const msg = error instanceof Error ? error.message : String(error);',
    '    log("ERROR", msg);',
    '  } finally {',
    '    inFlight = false;',
    '    if (timer) clearTimeout(timer);',
    '    timer = setTimeout(() => { void tick(); }, POLL_MS);',
    '  }',
    '}',
    '',
    'function stop(): void {',
    '  if (timer) clearTimeout(timer);',
    '  timer = null;',
    '}',
    '',
    'void tick();',
    '',
    'process.on("SIGINT", () => {',
    '  stop();',
    '  log("INFO", "Shutdown complete");',
    '  process.exit(0);',
    '});',
    '',
    'process.on("SIGTERM", () => {',
    '  stop();',
    '  log("INFO", "Shutdown complete");',
    '  process.exit(0);',
    '});',
  ].join("\n");
}

function patchLegacyStrategyBotFiles(
  files: GeneratedFile[],
  intent: Record<string, unknown>,
  promptText = "",
): GeneratedFile[] {
  // Solana-specific deterministic runtime patching is deprecated for the
  // Solana-first migration. Avoid forcing Solana runtime files into the
  // generated package — return files unchanged so downstream assembly uses
  // Solana templates or the LLM-produced sources as-is.
  return files;
}

function buildSafeSentimentIndexTs(): string {
  return [
    'import "dotenv/config";',
    'import { callMcpTool } from "./mcp_bridge.js";',
    '',
    'const POLL_MS = 15000;',
    'const SENTIMENT_BUY_THRESHOLD = 70;',
    'const SENTIMENT_SELL_THRESHOLD = 30;',
    'const SIMULATION_MODE = String(process.env.SIMULATION_MODE ?? "true").toLowerCase() !== "false";',
    'const BASE_COIN_TYPE = String(process.env.SOLANA_BASE_COIN_TYPE ?? process.env.SOLANA_BASE_COIN_TYPE ?? process.env.SOLANA_BASE_COIN_TYPE ?? process.env.SOLANA_BASE_COIN_TYPE ?? "0x1::coin::uinit").trim();',
    'const USDC_COIN_TYPE = String(process.env.SOLANA_USDC_METADATA_ADDRESS ?? process.env.SOLANA_USDC_METADATA_ADDRESS ?? process.env.SOLANA_USDC_METADATA_ADDRESS ?? process.env.SOLANA_USDC_METADATA_ADDRESS ?? "0x1::coin::uinit").trim();',
    '',
    'function log(level: string, message: string): void {',
    '  const ts = new Date().toISOString();',
    '  console.log("[" + ts + "] [" + level + "] " + message);',
    '}',
    '',
    'async function safeMcp(server: string, tool: string, args: Record<string, unknown>): Promise<unknown | null> {',
    '  try {',
    '    return await callMcpTool(server, tool, args);',
    '  } catch (error) {',
    '    const msg = error instanceof Error ? error.message : String(error);',
    '    log("WARN", "MCP " + server + "/" + tool + " unavailable: " + msg);',
    '    return null;',
    '  }',
    '}',
    '',
    'function extractScore(payload: unknown, fallback = 50): number {',
    '  if (!payload || typeof payload !== "object") return fallback;',
    '  const root = payload as Record<string, unknown>;',
    '  const result = (root.result && typeof root.result === "object") ? (root.result as Record<string, unknown>) : root;',
    '  const content = result.content;',
    '  if (Array.isArray(content) && content.length > 0) {',
    '    const text = (content[0] as Record<string, unknown>).text;',
    '    if (typeof text === "string") {',
    '      try {',
    '        const parsed = JSON.parse(text) as Record<string, unknown>;',
    '        const value = Number(parsed.sentiment ?? parsed.score ?? parsed.market_sentiment ?? fallback);',
    '        return Number.isFinite(value) ? value : fallback;',
    '      } catch {}',
    '    }',
    '  }',
    '  return fallback;',
    '}',
    '',
    'function requireConfiguredAddress(name: string, value: string): string {',
    '  const resolved = String(value ?? "").trim();',
    '  if (!resolved) throw new Error(name + " is not set");',
    '  return resolved;',
    '}',
    '',
    'function toBigInt(value: unknown): bigint | null {',
    '  if (typeof value === "bigint") return value;',
    '  if (typeof value === "number" && Number.isFinite(value)) return BigInt(Math.trunc(value));',
    '  if (typeof value === "string") {',
    '    const trimmed = value.trim();',
    '    if (!/^[0-9]+$/.test(trimmed)) return null;',
    '    try { return BigInt(trimmed); } catch { return null; }',
    '  }',
    '  return null;',
    '}',
    '',
    'function extractBalance(payload: unknown): bigint | null {',
    '  if (!payload || typeof payload !== "object") return null;',
    '  const root = payload as Record<string, unknown>;',
    '  const direct = toBigInt(root.balance ?? root.amount ?? root.value ?? root.coin_amount);',
    '  if (direct !== null) return direct;',
    '  const result = (root.result && typeof root.result === "object") ? (root.result as Record<string, unknown>) : null;',
    '  if (!result) return null;',
    '  return toBigInt(result.balance ?? result.amount ?? result.value ?? result.coin_amount);',
    '}',
    '',
    'async function readPoolBalance(address: string): Promise<bigint | null> {',
    '  const payload = await safeMcp("solana", "move_view", {',
    '    network: String(process.env.SOLANA_NETWORK ?? process.env.SOLANA_NETWORK ?? process.env.SOLANA_NETWORK ?? process.env.SOLANA_NETWORK ?? "mainnet-beta"),',
    '    address: "0x1",',
    '    module: "coin",',
    '    function: "balance",',
    '    type_args: [USDC_COIN_TYPE],',
    '    args: [address],',
    '  });',
    '  return extractBalance(payload);',
    '}',
    '',
    'async function fetchPrices(poolAAddress: string, poolBAddress: string): Promise<{ poolA: bigint; poolB: bigint }> {',
    '  const [poolA, poolB] = await Promise.all([readPoolBalance(poolAAddress), readPoolBalance(poolBAddress)]);',
    '  if (poolA === null || poolB === null) {',
    '    throw new Error("Failed to parse pool balances from move_view payload");',
    '  }',
    '  log("INFO", "[LISTEN] Pool A balance: " + poolA.toString());',
    '  log("INFO", "[LISTEN] Pool B balance: " + poolB.toString());',
    '  return { poolA, poolB };',
    '}',
    '',
    'async function runCycle(): Promise<void> {',
    '  log("INFO", "Solana sentiment cycle start");',
    '  const poolAAddress = requireConfiguredAddress("SOLANA_POOL_A_ADDRESS", process.env.SOLANA_POOL_A_ADDRESS ?? process.env.SOLANA_POOL_A_ADDRESS ?? process.env.SOLANA_POOL_A_ADDRESS ?? process.env.SOLANA_POOL_A_ADDRESS ?? "");',
    '  const poolBAddress = requireConfiguredAddress("SOLANA_POOL_B_ADDRESS", process.env.SOLANA_POOL_B_ADDRESS ?? process.env.SOLANA_POOL_B_ADDRESS ?? process.env.SOLANA_POOL_B_ADDRESS ?? process.env.SOLANA_POOL_B_ADDRESS ?? "");',
    '  const flashPoolAddress = requireConfiguredAddress("SOLANA_FLASH_POOL_ADDRESS", process.env.SOLANA_FLASH_POOL_ADDRESS ?? process.env.SOLANA_FLASH_POOL_ADDRESS ?? process.env.SOLANA_FLASH_POOL_ADDRESS ?? process.env.SOLANA_FLASH_POOL_ADDRESS ?? "");',
    '  const swapRouterAddress = requireConfiguredAddress("SOLANA_SWAP_ROUTER_ADDRESS", process.env.SOLANA_SWAP_ROUTER_ADDRESS ?? process.env.SOLANA_SWAP_ROUTER_ADDRESS ?? process.env.SOLANA_SWAP_ROUTER_ADDRESS ?? process.env.SOLANA_SWAP_ROUTER_ADDRESS ?? "");',
    '  const { poolA, poolB } = await fetchPrices(poolAAddress, poolBAddress);',
    '  const spread = poolA > poolB ? poolA - poolB : poolB - poolA;',
    '  const signedDelta = poolB > poolA ? poolB - poolA : -(poolA - poolB);',
    '  const sentiment = {',
    '    result: {',
    '      content: [{ text: JSON.stringify({ sentiment: Math.max(0, Math.min(100, 50 + Number(signedDelta / 100000n))) }) }],',
    '    },',
    '  };',
    '',
    '  const score = extractScore(sentiment);',
    '  log("INFO", "Sentiment score=" + score);',
    '  log("INFO", "Spread=" + spread.toString() + " p1=" + poolA.toString() + " p2=" + poolB.toString());',
    '  if (spread < 2000n) {',
    '    log("INFO", "Spread below threshold; hold");',
    '    return;',
    '  }',
    '',
    '  if (score > SENTIMENT_BUY_THRESHOLD) {',
    '    log("INFO", "Bullish threshold reached");',
    '    if (!SIMULATION_MODE) {',
    '      const network = String(process.env.SOLANA_NETWORK ?? process.env.SOLANA_NETWORK ?? process.env.SOLANA_NETWORK ?? process.env.SOLANA_NETWORK ?? "mainnet-beta");',
    '      await safeMcp("solana", "move_execute", {',
    '        network,',
    '        address: flashPoolAddress,',
    '        module: "flash_loan",',
    '        function: "borrow",',
    '        type_args: [BASE_COIN_TYPE, USDC_COIN_TYPE],',
    '        args: ["1000000"],',
    '      });',
    '      await safeMcp("solana", "move_execute", {',
    '        network,',
    '        address: swapRouterAddress,',
    '        module: "router",',
    '        function: "swap_exact_in",',
    '        type_args: [BASE_COIN_TYPE, USDC_COIN_TYPE],',
    '        args: ["1000000", "995000"],',
    '      });',
    '      await safeMcp("solana", "move_execute", {',
    '        network,',
    '        address: flashPoolAddress,',
    '        module: "flash_loan",',
    '        function: "repay",',
    '        type_args: [BASE_COIN_TYPE, USDC_COIN_TYPE],',
    '        args: ["1000900"],',
    '      });',
    '    }',
    '  } else if (score < SENTIMENT_SELL_THRESHOLD) {',
    '    log("INFO", "Bearish threshold reached; skipping long execution");',
    '  } else {',
    '    log("INFO", "Neutral sentiment; no execution");',
    '  }',
    '}',
    '',
    'let inFlight = false;',
    'let pollTimer: ReturnType<typeof setTimeout> | null = null;',
    'let backoffMs = POLL_MS;',
    '',
    'function scheduleNextCycle(delayMs: number): void {',
    '  if (pollTimer) clearTimeout(pollTimer);',
    '  pollTimer = setTimeout(() => { void tick(); }, delayMs);',
    '}',
    '',
    'const tick = async (): Promise<void> => {',
    '  if (inFlight) return;',
    '  inFlight = true;',
    '  try {',
    '    await runCycle();',
    '    backoffMs = POLL_MS;',
    '  } catch (error) {',
    '    const msg = error instanceof Error ? error.message : String(error);',
    '    log("ERROR", msg);',
    '    backoffMs = Math.min(POLL_MS * 8, Math.max(POLL_MS, backoffMs * 2));',
    '  } finally {',
    '    inFlight = false;',
    '    scheduleNextCycle(backoffMs);',
    '  }',
    '};',
    '',
    'void tick();',
    '',
    'function stopPolling(): void {',
    '  if (pollTimer) clearTimeout(pollTimer);',
    '  pollTimer = null;',
    '}',
    '',
    'process.on("SIGINT", () => {',
    '  stopPolling();',
    '  log("INFO", "Shutting down bot");',
    '  process.exit(0);',
    '});',
    '',
    'process.on("SIGTERM", () => {',
    '  stopPolling();',
    '  log("INFO", "Shutting down bot");',
    '  process.exit(0);',
    '});',
  ].join("\n");
}

function buildMcpBridgeTs(): string {
  return [
    'import "dotenv/config";',
    '',
    'const MCP_GATEWAY_URL = process.env.MCP_GATEWAY_URL ?? "http://localhost:8000/mcp";',
    'const MCP_GATEWAY_UPSTREAM_URL = process.env.MCP_GATEWAY_UPSTREAM_URL ?? "";',
    'const SIGNING_RELAY_BASE = process.env.SIGNING_RELAY_BASE ?? "";',
    '',
    'function isProxyGateway(value: string): boolean {',
    '  return /\\/api\\/mcp-proxy\\/?$/i.test(String(value || ""));',
    '}',
    '',
    'function normalizeGatewayBase(raw: string): string {',
    '  const value = String(raw ?? "").trim() || "http://localhost:8000/mcp";',
    '  const base = value.replace(/\\/+$/, "");',
    '  if (isProxyGateway(base)) return base;',
    '  return /\\/mcp$/i.test(base) ? base : base + "/mcp";',
    '}',
    '',
    'function buildCandidateUrls(base: string, server: string, tool: string): string[] {',
    '  const withMcp = /\\/mcp$/i.test(base) ? base : base + "/mcp";',
    '  const withoutMcp = withMcp.replace(/\\/mcp$/i, "");',
    '  return [withMcp + "/" + server + "/" + tool, withoutMcp + "/" + server + "/" + tool];',
    '}',
    '',
    'function deriveRelayBase(): string {',
    '  const explicitRelayBase = String(SIGNING_RELAY_BASE ?? "").trim();',
    '  if (explicitRelayBase) {',
    '    if (isProxyGateway(explicitRelayBase)) return explicitRelayBase.replace(/\\/api\\/mcp-proxy\\/?$/i, "");',
    '    try {',
    '      const relayUrl = new URL(explicitRelayBase);',
    '      return relayUrl.origin;',
    '    } catch {',
    '      return explicitRelayBase;',
    '    }',
    '  }',
    '',
    '  const raw = String(MCP_GATEWAY_URL ?? "").trim();',
    '  if (!raw) return "http://localhost:3000";',
    '  if (isProxyGateway(raw)) return raw.replace(/\\/api\\/mcp-proxy\\/?$/i, "");',
    '  try {',
    '    const url = new URL(raw);',
    '    return url.origin;',
    '  } catch {',
    '    return "http://localhost:3000";',
    '  }',
    '}',
    '',
    'const RELAY_BASE = deriveRelayBase();',
    'const RELAY_POLL_INTERVAL_MS = 600;',
    'const RELAY_TIMEOUT_MS = 90_000;',
    '',
    'function isRelayUnavailableError(message: string): boolean {',
    '  const value = String(message || "");',
    '  return /fetch failed|network|econnrefused|enotfound|Endpoint not found|Signing relay submit failed \\(404\\)|Signing relay poll failed \\(404\\)/i.test(value);',
    '}',
    '',
    'async function callGateway(server: string, tool: string, args: Record<string, unknown>): Promise<unknown> {',
    '  const base = normalizeGatewayBase(MCP_GATEWAY_URL);',
    '  const urls = buildCandidateUrls(base, server, tool);',
    '',
    '  let lastError = "unknown error";',
    '  for (const url of urls) {',
    '    const res = await fetch(url, {',
    '      method: "POST",',
    '      headers: {',
    '        "Content-Type": "application/json",',
    '        "ngrok-skip-browser-warning": "true",',
    '        "Bypass-Tunnel-Reminder": "true",',
    '        ...(MCP_GATEWAY_UPSTREAM_URL ? { "x-mcp-upstream-url": MCP_GATEWAY_UPSTREAM_URL } : {}),',
    '      },',
    '      body: JSON.stringify(args ?? {}),',
    '    });',
    '    if (!res.ok) {',
    '      const body = await res.text().catch(() => "");',
    '      lastError = "MCP call failed: " + res.status + " " + body;',
    '      if (res.status === 404) continue;',
    '      throw new Error(lastError);',
    '    }',
    '    return res.json();',
    '  }',
    '  throw new Error(lastError);',
    '}',
    '',
    'async function callSigningRelay(args: Record<string, unknown>): Promise<unknown> {',
    '  const submitUrl = RELAY_BASE + "/api/signing-relay";',
    '  const submitBody: Record<string, unknown> = {};',
    '  if (args.rawTx) {',
    '    submitBody.rawTx = args.rawTx;',
    '    submitBody.network = args.network ?? "solana";',
    '  } else if (args.programId || args.instructionData) {',
    '    submitBody.programId = args.programId ?? args.address;',
    '    submitBody.instructionData = args.instructionData ?? JSON.stringify({ function: args.function, args: args.args ?? [] });',
    '    submitBody.accounts = args.accounts ?? [];',
    '    submitBody.network = args.network ?? "solana";',
    '  } else {',
    '    submitBody.network = args.network ?? "mainnet-beta";',
    '    submitBody.moduleAddress = args.address;',
    '    submitBody.moduleName = args.module;',
    '    submitBody.functionName = args.function;',
    '    submitBody.typeArgs = args.type_args ?? [];',
    '    submitBody.args = args.args ?? [];',
    '  }',
    '  const submitRes = await fetch(submitUrl, {',
    '    method: "POST",',
    '    headers: { "Content-Type": "application/json" },',
    '    body: JSON.stringify(submitBody),',
    '  });',
    '  if (!submitRes.ok) {',
    '    const errText = await submitRes.text().catch(() => "");',
    '    throw new Error("Signing relay submit failed (" + submitRes.status + "): " + errText.slice(0, 200));',
    '  }',
    '  const payload = (await submitRes.json()) as { requestId?: string };',
    '  const requestId = String(payload.requestId ?? "").trim();',
    '  if (!requestId) throw new Error("Signing relay did not return a requestId.");',
    '  const deadline = Date.now() + RELAY_TIMEOUT_MS;',
    '  const resultUrl = RELAY_BASE + "/api/signing-relay/" + requestId;',
    '  while (Date.now() < deadline) {',
    '    await new Promise((resolve) => setTimeout(resolve, RELAY_POLL_INTERVAL_MS));',
    '    const pollRes = await fetch(resultUrl, { headers: { "Cache-Control": "no-store" } });',
    '    if (!pollRes.ok) {',
    '      throw new Error("Signing relay poll failed (" + pollRes.status + ").");',
    '    }',
    '    const data = (await pollRes.json()) as { status: string; result?: { txHash?: string; error?: string } };',
    '    if (data.status === "signed" && data.result?.txHash) {',
    '      return { txHash: data.result.txHash, success: true };',
    '    }',
    '    if (data.status === "failed") {',
    '      throw new Error("Signing failed: " + (data.result?.error ?? "unknown error"));',
    '    }',
    '    if (data.status === "timeout") {',
    '      throw new Error("Signing request timed out. Ensure AutoSign is enabled in the browser.");',
    '    }',
    '  }',
    '  throw new Error("Signing relay timed out after " + (RELAY_TIMEOUT_MS / 1000) + "s. Check that the browser tab is open with AutoSign enabled.");',
    '}',
    '',
    'export async function callMcpTool(server: string, tool: string, args: Record<string, unknown>): Promise<unknown> {',
    '  if (server === "solana" && tool === "move_execute") {',
    '    try {',
    '      return await callSigningRelay(args);',
    '    } catch (error) {',
    '      const msg = error instanceof Error ? error.message : String(error);',
    '      if (!isRelayUnavailableError(msg)) {',
    '        throw error;',
    '      }',
    '      return callGateway(server, tool, args);',
    '    }',
    '  }',
    '  return callGateway(server, tool, args);',
    '}',
    '',
    '// SAFELY ABSTRACTION FOR FA BALANCES',
    'export async function getFaBalance(network: string, walletAddress: string, metadataAddress: string): Promise<bigint> {',
    '  try {',
    '    const payload = await callMcpTool("solana", "move_view", {',
    '      network,',
    '      address: "0x1",',
    '      module: "primary_fungible_store",',
    '      function: "balance",',
    '      type_args: ["0x1::fungible_asset::Metadata"],',
    '      args: [walletAddress, metadataAddress]',
    '    });',
    '    const str = JSON.stringify(payload || {});',
    '    const match = str.match(/"(?:balance|amount|value|coin_amount)"\\s*:\\s*"(\\d+)"/) || str.match(/\\[\\s*"(\\d+)"\\s*\\]/);',
    '    return match ? BigInt(match[1]) : 0n;',
    '  } catch (err) {',
    '    console.warn("Failed to get FA balance:", err instanceof Error ? err.message : String(err));',
    '    return 0n;',
    '  }',
    '}',
  ].join("\n");
}

function sanitizeLegacyIndexTemplates(files: GeneratedFile[], intent: Record<string, unknown>): GeneratedFile[] {
  // Support Solana-first deterministic fallbacks as well as legacy Solana.
  const chain = String(intent.chain ?? "").toLowerCase();
  const useYieldTemplate = isYieldSweeperIntent(intent);

  return files.map((file) => {
    const cleanPath = file.filepath.replace(/^[./]+/, "");
    if (cleanPath !== "src/index.ts" || typeof file.content !== "string") {
      return file;
    }

    const content = file.content;
    const looksCorrupted =
      content.includes("callSigningRelay(") ||
      content.includes("deriveRelayBase(") ||
      content.includes("buildCandidateUrls(") ||
      content.includes("moduleAddress:") ||
      content.includes("functionName:") ||
      content.includes("typeArgs:") ||
      content.includes("Signing relay timed out");

    if (!looksCorrupted) {
      return file;
    }

    // If the intent targets Solana, return a small Solana-based index.ts
    if (chain === "solana") {
      return {
        ...file,
        content: useYieldTemplate ? buildSolanaYieldSweeperIndexTs() : buildSolanaSpreadScannerIndexTs(),
      };
    }

    // Fallback legacy behavior for Solana
    if (chain === "solana") {
      return {
        ...file,
        content: useYieldTemplate ? buildSafeYieldSweeperIndexTs() : buildSafeSpreadScannerIndexTs(),
      };
    }

    return file;
  });
}

function buildSolanaYieldSweeperIndexTs(): string {
  return [
    'import "dotenv/config";',
    'import { Connection, PublicKey, Keypair, SystemProgram, Transaction, LAMPORTS_PER_SOL } from "@solana/web3.js";',
    'import fs from "fs";',
    '',
    'const RPC = process.env.SOLANA_RPC_URL ?? "http://127.0.0.1:8899";',
    'const WALLET = process.env.USER_WALLET_ADDRESS ?? "";',
    'const KEYPAIR_PATH = process.env.KEYPAIR_PATH ?? "";',
    'const RECIPIENT = process.env.RECIPIENT_ADDRESS ?? "";',
    'const POLL_MS = (Number(process.env.POLL_INTERVAL ?? "15") || 15) * 1000;',
    'const SIMULATION = String(process.env.SIMULATION_MODE ?? "true").toLowerCase() !== "false";',
    '',
    'function log(level: string, msg: string) { console.log(`[${new Date().toISOString()}] [${level}] ${msg}`); }',
    '',
    'async function getBalance(connection: Connection, addr: string) { return (await connection.getBalance(new PublicKey(addr), "confirmed")) / LAMPORTS_PER_SOL; }',
    '',
    'async function runCycle() {',
    '  if (!WALLET) throw new Error("USER_WALLET_ADDRESS is required in .env");',
    '  const conn = new Connection(RPC, { commitment: "confirmed" });',
    '  const balance = await getBalance(conn, WALLET);',
    '  log("INFO", `Balance (${WALLET}) = ${balance} SOL`);',
    '  const threshold = Number(process.env.SWEEP_THRESHOLD_SOL ?? "0.1");',
    '  if (balance <= threshold) return;',
    '  if (SIMULATION) { log("INFO", `SIMULATION: would transfer from ${WALLET} to ${RECIPIENT}`); return; }',
    '  if (!KEYPAIR_PATH || !fs.existsSync(KEYPAIR_PATH)) { log("WARN", "No KEYPAIR_PATH provided or file not found — cannot sign from server."); return; }',
    '  const secret = Uint8Array.from(JSON.parse(fs.readFileSync(KEYPAIR_PATH, "utf8")));',
    '  const kp = Keypair.fromSecretKey(secret);',
    '  const to = new PublicKey(RECIPIENT);',
    '  const lamports = Math.floor(Number(process.env.SWEEP_AMOUNT_SOL ?? "0.01") * LAMPORTS_PER_SOL);',
    '  const tx = new Transaction().add(SystemProgram.transfer({ fromPubkey: kp.publicKey, toPubkey: to, lamports }));',
    '  tx.feePayer = kp.publicKey;',
    '  const { blockhash } = await conn.getLatestBlockhash("finalized");',
    '  tx.recentBlockhash = blockhash;',
    '  tx.sign(kp);',
    '  const raw = tx.serialize();',
    '  const sig = await conn.sendRawTransaction(raw);',
    '  await conn.confirmTransaction(sig, "confirmed");',
    '  log("INFO", `Transfer sent: ${sig}`);',
    '}',
    '',
    'setInterval(() => { void runCycle(); }, POLL_MS);',
  ].join("\n");
}

function buildSolanaSpreadScannerIndexTs(): string {
  return [
    'import "dotenv/config";',
    'import { Connection, PublicKey } from "@solana/web3.js";',
    '',
    'const RPC = process.env.SOLANA_RPC_URL ?? "http://127.0.0.1:8899";',
    'const POLL_MS = (Number(process.env.POLL_INTERVAL ?? "15") || 15) * 1000;',
    'const OWNER = process.env.USER_WALLET_ADDRESS ?? "";',
    'const POOL_A_MINT = process.env.POOL_A_MINT ?? "";',
    'const POOL_B_MINT = process.env.POOL_B_MINT ?? "";',
    'const SPREAD_THRESHOLD = Number(process.env.SPREAD_THRESHOLD ?? "1");',
    '',
    'function log(level: string, msg: string) { console.log(`[${new Date().toISOString()}] [${level}] ${msg}`); }',
    '',
    'async function totalTokenBalance(conn: Connection, owner: string, mint: string): Promise<number> {',
    '  if (!owner || !mint) return 0;',
    '  const ownerPk = new PublicKey(owner);',
    '  const mintPk = new PublicKey(mint);',
    '  const accounts = await conn.getTokenAccountsByOwner(ownerPk, { mint: mintPk }, "confirmed");',
    '  let total = 0;',
    '  for (const acc of accounts.value) {',
    '    try {',
    '      const bal = await conn.getTokenAccountBalance(acc.pubkey, "confirmed");',
    '      const ui = bal.value.uiAmount ?? (Number(bal.value.amount) / Math.pow(10, bal.value.decimals));',
    '      total += Number(ui || 0);',
    '    } catch (e) { /* ignore malformed accounts */ }',
    '  }',
    '  return total;',
    '}',
    '',
    'async function runCycle() {',
    '  try {',
    '    if (!OWNER) { log("WARN", "USER_WALLET_ADDRESS not set; skipping spread scan"); return; }',
    '    if (!POOL_A_MINT || !POOL_B_MINT) { log("WARN", "POOL_A_MINT or POOL_B_MINT not set; configure token mints to scan"); return; }',
    '    const conn = new Connection(RPC, { commitment: "confirmed" });',
    '    const a = await totalTokenBalance(conn, OWNER, POOL_A_MINT);',
    '    const b = await totalTokenBalance(conn, OWNER, POOL_B_MINT);',
    '    log("INFO", `Pool A balance: ${a}  Pool B balance: ${b}`);',
    '    const spread = Math.abs(a - b);',
    '    if (spread >= SPREAD_THRESHOLD) {',
    '      log("INFO", `Spread ${spread} >= threshold ${SPREAD_THRESHOLD} — action recommended (manual or implement execution)`);',
    '    } else {',
    '      log("INFO", `No actionable spread (spread=${spread})`);',
    '    }',
    '  } catch (err) {',
    '    log("ERROR", String(err));',
    '  }',
    '}',
    '',
    'setInterval(() => { void runCycle(); }, POLL_MS);',
  ].join("\n");
}

function buildSolanaSentimentIndexTs(): string {
  return [
    'import "dotenv/config";',
    '',
    'const POLL_MS = (Number(process.env.POLL_INTERVAL ?? "15") || 15) * 1000;',
    'const SIGNAL_TEXTS = String(process.env.SIGNAL_TEXTS ?? "").split("|").map(s => s.trim()).filter(Boolean);',
    'const BUY_THRESHOLD = Number(process.env.SENTIMENT_BUY_THRESHOLD ?? "70");',
    '',
    'function log(level: string, msg: string) { console.log(`[${new Date().toISOString()}] [${level}] ${msg}`); }',
    '',
    'function naiveScore(text: string): number {',
    '  if (!text) return 50;',
    '  let score = 50;',
    '  const bull = /(bull|buy|long|moon|pump)/i;',
    '  const bear = /(bear|sell|short|dump|rekt)/i;',
    '  if (bull.test(text)) score += 20;',
    '  if (bear.test(text)) score -= 20;',
    '  return Math.max(0, Math.min(100, score));',
    '}',
    '',
    'async function runCycle() {',
    '  try {',
    '    const texts = SIGNAL_TEXTS.length ? SIGNAL_TEXTS : ["no signals provided"];',
    '    const scores = texts.map(t => naiveScore(t));',
    '    const avg = scores.reduce((a,b) => a+b, 0) / Math.max(1, scores.length);',
    '    log("INFO", `Sentiment avg=${avg} (scores=${JSON.stringify(scores)})`);',
    '    if (avg >= BUY_THRESHOLD) {',
    '      log("INFO", "Bullish sentiment detected — consider execution (SIMULATION mode prevents on-chain actions)");',
    '    }',
    '  } catch (err) {',
    '    log("ERROR", String(err));',
    '  }',
    '}',
    '',
    'setInterval(() => { void runCycle(); }, POLL_MS);',
  ].join("\n");
}

function patchSentimentBotFiles(files: GeneratedFile[], intent: Record<string, unknown>) {
  const isSentiment = isSentimentIntent(intent);
  if (!isSentiment) return files;

  const chain = String(intent.chain ?? "").toLowerCase();
  const hasIndex = files.some((file) => file.filepath.replace(/^[./]+/, "") === "src/index.ts");
  if (!hasIndex) return files;

  let packageJsonPatched = false;
  let hasMcpBridgeFile = false;

  const patched = files.map((file) => {
    const cleanPath = file.filepath.replace(/^[./]+/, "");
    if (cleanPath === "src/index.ts") {
      return { ...file, content: chain === "solana" ? buildSolanaSentimentIndexTs() : buildSafeSentimentIndexTs() };
    }

    if (cleanPath === "src/mcp_bridge.ts") {
      hasMcpBridgeFile = true;
      return { ...file, content: buildMcpBridgeTs() };
    }

    if (cleanPath === "package.json") {
      packageJsonPatched = true;
      try {
        const raw = typeof file.content === "string" ? file.content : JSON.stringify(file.content ?? {}, null, 2);
        const parsed = JSON.parse(raw) as { name?: string; description?: string; dependencies?: Record<string, string>; scripts?: Record<string, string> };

        const baseDeps: Record<string, string> = { ...(parsed.dependencies ?? {}), dotenv: "^16.4.0" };
        if (chain === "solana") baseDeps["@solana/web3.js"] = "^1.96.0"; else baseDeps["axios"] = "^1.7.4";

        const scripts = { ...(parsed.scripts ?? {}), start: parsed.scripts?.start ?? "tsx src/index.ts", dev: parsed.scripts?.dev ?? "tsx src/index.ts" };

        const nextPkg = { ...parsed, name: chain === "solana" ? "solana-sentiment-bot" : "solana-sentiment-bot", description: chain === "solana" ? "Solana sentiment bot" : "Solana sentiment bot using solana MCP", dependencies: baseDeps, scripts };
        return { ...file, content: JSON.stringify(nextPkg, null, 2) };
      } catch {
        return file;
      }
    }

    return file;
  });

  const ensuredMcpBridge = hasMcpBridgeFile ? patched : [...patched, { filepath: "src/mcp_bridge.ts", content: buildMcpBridgeTs(), language: "typescript" }];
  if (packageJsonPatched) return ensuredMcpBridge;

  if (chain === "solana") {
    const fallbackPkg = JSON.stringify({ name: "solana-sentiment-bot", version: "1.0.0", type: "module", description: "Solana sentiment bot", scripts: { start: "tsx src/index.ts", dev: "tsx src/index.ts" }, dependencies: { "@solana/web3.js": "^1.96.0", dotenv: "^16.4.0" }, devDependencies: { typescript: "^5.0.0", tsx: "^4.7.0" } }, null, 2);
    return [...ensuredMcpBridge, { filepath: "package.json", content: fallbackPkg }];
  }

  const fallbackSentimentPackage = JSON.stringify(
    {
      name: "solana-sentiment-bot",
      version: "1.0.0",
      type: "module",
      description: "Solana sentiment bot using solana MCP",
      scripts: { start: "tsx src/index.ts", dev: "tsx src/index.ts" },
      dependencies: { axios: "^1.7.4", dotenv: "^16.4.0" },
      devDependencies: { typescript: "^5.4.0", "@types/node": "^20.0.0", tsx: "^4.7.0" },
    },
    null,
    2,
  );

  return [...ensuredMcpBridge, { filepath: "package.json", content: fallbackSentimentPackage, language: "json" }];
}


function isYieldSweeperIntent(intent: Record<string, unknown>): boolean {
  const strategy = String(intent.strategy ?? "").toLowerCase();
  const botType = String(intent.bot_type ?? intent.bot_name ?? "").toLowerCase();
  if (strategy === "cross_chain_sweep") return false;
  return strategy === "yield" || strategy === "yield_sweeper" || /sweep|yield/.test(botType);
}


function isSentimentIntent(intent: Record<string, unknown>): boolean {
  const strategy = String(intent.strategy ?? "").toLowerCase();
  return strategy === "sentiment";
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function deriveFallbackIntent(prompt: string): Record<string, unknown> {
  const lowered = String(prompt ?? "").toLowerCase();
  const isCrossChainLiquidation = /(liquidation sniper|omni-chain liquidat|cross[-. ]chain liquidat)/.test(lowered);
  const isCrossChainArbitrage = /(flash[-. ]bridge|spatial arb|cross[-. ]chain arb)/.test(lowered);
  const isCrossChainSweep = /(yield nomad|auto[-. ]compounder|omni[-. ]chain yield)/.test(lowered);
  const isYield = /(yield sweeper|auto-consolidator|sweep_to_l1|bridge back to l1|sweep)/.test(lowered);
  const isSentiment = /(sentiment|social)/.test(lowered);
  const isCustomUtility = /(custom utility|custom workflow|intent:\s*custom|strategy:\s*custom)/.test(lowered);

  if (isCrossChainLiquidation) {
    return {
      chain: "solana",
      network: "mainnet-beta",
      execution_model: "polling",
      strategy: "cross_chain_liquidation",
      bot_type: "Omni-Chain Liquidation Sniper",
      bot_name: "Omni-Chain Liquidation Sniper",
      mcps: ["solana"],
      required_mcps: ["solana"],
      requires_openai_key: false,
    };
  }

  if (isCrossChainArbitrage) {
    return {
      chain: "solana",
      network: "mainnet-beta",
      execution_model: "polling",
      strategy: "cross_chain_arbitrage",
      bot_type: "Flash-Bridge Spatial Arbitrageur",
      bot_name: "Flash-Bridge Spatial Arbitrageur",
      mcps: ["solana"],
      required_mcps: ["solana"],
      requires_openai_key: false,
    };
  }

  if (isCrossChainSweep) {
    return {
      chain: "solana",
      network: "mainnet-beta",
      execution_model: "polling",
      strategy: "cross_chain_sweep",
      bot_type: "Omni-Chain Yield Nomad",
      bot_name: "Omni-Chain Yield Nomad",
      mcps: ["solana"],
      required_mcps: ["solana"],
      requires_openai_key: false,
    };
  }

  if (isCustomUtility) {
    return {
      chain: "solana",
      network: "mainnet-beta",
      execution_model: "polling",
      strategy: "custom_utility",
      bot_type: "Custom Utility Solana Bot",
      mcps: ["solana"],
      required_mcps: ["solana"],
      requires_openai_key: false,
    };
  }

  if (isSentiment) {
    return {
      chain: "solana",
      network: "mainnet-beta",
      execution_model: "agentic",
      strategy: "sentiment",
      bot_type: "Solana Sentiment Bot",
      mcps: ["solana"],
      required_mcps: ["solana"],
      requires_openai_key: true,
    };
  }

  if (isYield) {
    return {
      chain: "solana",
      network: "mainnet-beta",
      execution_model: "polling",
      strategy: "yield",
      bot_type: "Cross-Rollup Yield Sweeper",
      mcps: ["solana"],
      required_mcps: ["solana"],
      requires_openai_key: false,
    };
  }

  return {
    chain: "solana",
    network: "mainnet-beta",
    execution_model: "polling",
    strategy: "arbitrage",
    bot_type: "Cross-Rollup Spread Scanner",
    mcps: ["solana"],
    required_mcps: ["solana"],
    requires_openai_key: false,
  };
}

function pickPublicGateway(preferred: string, fallback: string): string {
  const value = String(preferred ?? "").trim();
  const backup = String(fallback ?? "").trim();

  const isLocal = (url: string): boolean => {
    const normalized = String(url || "").trim().toLowerCase();
    return (
      normalized.includes("localhost") ||
      normalized.includes("127.0.0.1") ||
      normalized.includes("0.0.0.0") ||
      normalized.includes("192.168.")
    );
  };

  if (value && !isLocal(value)) return value;
  if (backup && !isLocal(backup)) return backup;
  if (value) return value;
  return backup;
}

function loadAgentEnvDefaults(): Record<string, string> {
  const out: Record<string, string> = {};
  const candidates = [
    path.resolve(process.cwd(), "../agents/.env"),
    path.resolve(process.cwd(), "../agents/.env.local"),
  ];

  for (const file of candidates) {
    try {
      if (!fs.existsSync(file)) continue;
      const parsed = parseEnvText(fs.readFileSync(file, "utf8"));
      Object.assign(out, parsed);
    } catch {
      // ignore missing/unreadable defaults
    }
  }

  return out;
}

async function ensureAgentWalletAddressColumn(requestId: string): Promise<void> {
  console.warn(`[generate-bot] [${requestId}] Applying fallback schema fix for Agent.walletAddress`);
  await prisma.$executeRawUnsafe(
    'ALTER TABLE "Agent" ADD COLUMN IF NOT EXISTS "walletAddress" TEXT NOT NULL DEFAULT \'\''
  );
}

export async function POST(req: NextRequest) {
  const requestId = crypto.randomUUID().slice(0, 8);
  const requestStartedAt = Date.now();
  console.log(`[generate-bot] [${requestId}] Received request`);

  try {
    const auth = await requireWalletAuth(req);
    if (auth.error || !auth.user) {
      return auth.error ?? NextResponse.json({ error: "Unauthorized." }, { status: 401 });
    }

    const userId = auth.user.id; // Capture early for type safety
    const body = await req.json();
    console.log(`[generate-bot] [${requestId}] Body keys:`, Object.keys(body));
    const granterWalletAddress = typeof body.walletAddress === "string" ? body.walletAddress.trim() : "";

    // Accept both `prompt` (original) and `expandedPrompt` (pre-expanded by classify-intent).
    // Always prefer the expanded prompt — it gives the meta-agent far more context.
    const expandedPrompt: string = body.expandedPrompt || body.prompt;
    const originalPrompt: string = body.prompt || expandedPrompt;
    const promptBundle = compactPromptForMetaAgent(expandedPrompt || originalPrompt || "");
    const boundedPrompt = promptBundle.prompt;
    const warnings: string[] = [];
    if (promptBundle.truncated) {
      warnings.push("Prompt was truncated before reaching the Meta-Agent; critical details may have been dropped.");
    }
    const envDefaults = loadAgentEnvDefaults();
    const envConfig: Record<string, string> = {
      ...envDefaults,
      ...(body.envConfig || {}),
    };

    if (!boundedPrompt?.trim()) {
      return NextResponse.json({ error: "Prompt is required." }, { status: 400 });
    }

  console.log(`[generate-bot] [${requestId}] Using prompt length:`, boundedPrompt.length, "chars");
    if (promptBundle.truncated) {
      console.warn(`[generate-bot] [${requestId}] User prompt was truncated to ${boundedPrompt.length} chars before meta-agent submission`);
    }

    // Inject verified system parameters AT THE VERY TOP so the planner sees them
    let injectedParams = "--- VERIFIED SYSTEM PARAMETERS ---\n";
    if (granterWalletAddress) {
      injectedParams += `USER_WALLET_ADDRESS=${granterWalletAddress}\n`;
    }
    if (envConfig.TOKEN_MINT_ADDRESS) {
      injectedParams += `TOKEN_MINT_ADDRESS=${envConfig.TOKEN_MINT_ADDRESS}\n`;
    }
    if (envConfig.SOLANA_NETWORK) {
      injectedParams += `SOLANA_NETWORK=${envConfig.SOLANA_NETWORK}\n`;
    }

    // 🚨 ADD THIS DIRECTIVE TO FORCE .ENV GENERATION 🚨
    injectedParams += `
CRITICAL SYSTEM REQUIREMENT:
You MUST output a '.env' file artifact containing the VERIFIED SYSTEM PARAMETERS above, alongside any other environment variables your code requires to run smoothly (e.g., POLL_INTERVAL_MS, TRADE_AMOUNT_LAMPORTS). 
DO NOT assume the user will create this file. YOU must generate the '.env' file. 
Ensure your main entry file imports 'dotenv/config' at the top.
`;

    // PREPEND the parameters instead of appending them so they fall within the planner's truncation window
    const finalPromptForMetaAgent = injectedParams + "\n\nUSER PROMPT:\n" + boundedPrompt;

    // ── Stream backend response via SSE ────────────────────────────────────
    console.log(`[generate-bot] [${requestId}] Initiating SSE stream to backend`);

    const metaResponse = await fetch(`${META_AGENT_URL}/generate-stream`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-request-id": requestId,
      },
      body: JSON.stringify({ prompt: finalPromptForMetaAgent }),
    });

    if (!metaResponse.ok || !metaResponse.body) {
      const errText = await metaResponse.text().catch(() => "");
      console.error(`[generate-bot] [${requestId}] Backend stream failed: ${metaResponse.status}`, errText);
      return NextResponse.json(
        { error: `Meta-Agent streaming failed: ${metaResponse.status}` },
        { status: metaResponse.status || 500 }
      );
    }

    // Create a streaming response that pipes SSE events from backend
    // and intercepts the final 'complete' event to save the agent to the database
    const stream = new ReadableStream({
      async start(controller) {
        const reader = metaResponse.body!.getReader();
        const decoder = new TextDecoder();
        const encoder = new TextEncoder();
        let buffer = "";
        let finalPayload: Record<string, unknown> | null = null;
        let agentId: string | null = null;

        const flushEvent = async (eventText: string): Promise<void> => {
          const trimmed = eventText.trim();
          if (!trimmed) return;

          const raw = trimmed
            .split(/\r?\n/)
            .filter((line) => line.startsWith("data:"))
            .map((line) => line.slice(5).trimStart())
            .join("\n")
            .trim();

          if (!raw) {
            controller.enqueue(encoder.encode(`${trimmed}\n\n`));
            return;
          }

          let payload: Record<string, unknown> | null = null;
          try {
            payload = JSON.parse(raw) as Record<string, unknown>;
          } catch {
            controller.enqueue(encoder.encode(`${trimmed}\n\n`));
            return;
          }

          if (payload.status !== "complete") {
            controller.enqueue(encoder.encode(`${trimmed}\n\n`));
            return;
          }

          finalPayload = payload;
          console.log(`[generate-bot] [${requestId}] Intercepted complete event, saving to DB`);

          try {
            agentId = await saveBotToDatabase(
              requestId,
              finalPayload,
              granterWalletAddress,
              originalPrompt,
              expandedPrompt,
              envConfig,
              envDefaults,
              userId,
            );
            console.log(`[generate-bot] [${requestId}] Saved bot with agentId: ${agentId}`);
          } catch (dbErr) {
            const msg = dbErr instanceof Error ? dbErr.message : String(dbErr);
            console.error(`[generate-bot] [${requestId}] Failed to save bot to DB:`, msg);
          }

          if (finalPayload && agentId) {
            const finalEvent = `data: ${JSON.stringify({ ...finalPayload, agentId })}\n\n`;
            controller.enqueue(encoder.encode(finalEvent));
          }
        };

        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            buffer += decoder.decode(value, { stream: true });
            const events = buffer.split(/\r?\n\r?\n/);
            buffer = events.pop() ?? "";

            for (const eventText of events) {
              await flushEvent(eventText);
            }
          }

          buffer += decoder.decode();
          const tailEvents = buffer.split(/\r?\n\r?\n/);
          buffer = tailEvents.pop() ?? "";
          for (const eventText of tailEvents) {
            await flushEvent(eventText);
          }

          if (buffer.trim()) {
            await flushEvent(buffer);
          }

          controller.close();
        } catch (streamErr) {
          const msg = streamErr instanceof Error ? streamErr.message : String(streamErr);
          console.error(`[generate-bot] [${requestId}] Stream error:`, msg);
          controller.error(streamErr);
        }
      },
    });

    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        "Connection": "keep-alive",
      },
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[generate-bot] [${requestId}] Error:`, msg);
    return NextResponse.json(
      { error: msg },
      { status: 500 }
    );
  }
}

// Helper: Save completed bot to database
async function saveBotToDatabase(
  requestId: string,
  finalPayload: Record<string, unknown>,
  granterWalletAddress: string,
  originalPrompt: string,
  expandedPrompt: string,
  envConfig: Record<string, string>,
  envDefaults: Record<string, string>,
  userId: string,
): Promise<string> {
  const intent = sanitizeIntentMcpLists((finalPayload.intent || {}) as Record<string, unknown>);
  const botName: string = (intent.bot_name as string) || (intent.bot_type as string) || "Universal DeFi Bot";
  const filesList = finalPayload.files || [];

  let normalizedFiles: GeneratedFile[] = (Array.isArray(filesList) ? filesList : [])
    .map((raw: unknown, idx: number) => {
      const candidate = raw as Record<string, unknown>;
      const filepath =
        (typeof candidate?.filepath === "string" && candidate.filepath.trim()) ||
        (typeof candidate?.path === "string" && candidate.path.trim()) ||
        (typeof candidate?.filename === "string" && candidate.filename.trim()) ||
        `generated_${idx + 1}.txt`;

      const content = candidate?.content ?? candidate?.code ?? candidate?.text ?? "";
      const language = typeof candidate?.language === "string" ? candidate.language : undefined;

      return language ? { filepath, content, language } : { filepath, content };
    })
    .filter((f: { filepath: string }) => ![".env", ".env.example"].includes(f.filepath));

  // Build final environment config
  const publicGatewayFallback = pickPublicGateway(
    envDefaults.MCP_GATEWAY_URL || process.env.MCP_GATEWAY_URL || "",
    "http://localhost:8000/mcp",
  );

  const finalEnv: Record<string, string> = {
    ...envConfig,
    MCP_GATEWAY_URL: pickPublicGateway(envConfig.MCP_GATEWAY_URL || "", publicGatewayFallback),
    SIMULATION_MODE: "false",
  };

  const sessionKeyMode = String(finalEnv.SESSION_KEY_MODE || "").toLowerCase() === "true";
  if (sessionKeyMode) {
    finalEnv.SESSION_KEY_MODE = "true";
  }

  let envPlaintext = "";
  for (const [key, val] of Object.entries(finalEnv)) {
    if (val) envPlaintext += `${key}=${val}\n`;
  }
  const encryptedEnv = encryptEnvConfig(envPlaintext);

  // Ensure a deterministic .env file is included so WebContainer receives required envs
  if (envPlaintext && envPlaintext.trim()) {
    normalizedFiles.push({ filepath: ".env", content: envPlaintext });
  }

  // Create agent record in database
  const configRecord: Prisma.InputJsonObject = {
    generatedAt: new Date().toISOString(),
    intent: intent as Prisma.InputJsonValue,
    toolsUsed: (finalPayload.tools_used ?? []) as Prisma.InputJsonValue,
    originalPrompt,
  };

  const agentCreateData: Prisma.AgentCreateInput = {
    name: botName,
    user: { connect: { id: userId } },
    status: "STOPPED" as const,
    walletAddress: granterWalletAddress,
    configuration: configRecord,
    envConfig: encryptedEnv,
    files: {
      create: normalizedFiles.map((f: GeneratedFile) => ({
        filepath: typeof f.filepath === "string" && f.filepath.trim()
          ? f.filepath
          : "generated.txt",
        content:
          typeof f.content === "object"
            ? JSON.stringify(f.content, null, 2)
            : String(f.content),
        language: (() => {
          const fp = typeof f.filepath === "string" ? f.filepath : "";
          return (
            f.language ??
            (fp.endsWith(".ts") ? "typescript"
              : fp.endsWith(".py") ? "python"
              : fp.endsWith(".json") ? "json"
              : "plaintext")
          );
        })(),
      })),
    },
  };

  let agent: Awaited<ReturnType<typeof prisma.agent.create>>;
  try {
    agent = await prisma.agent.create({ data: agentCreateData });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    const missingWalletAddressColumn =
      msg.includes("walletAddress") && msg.includes("does not exist");

    if (!missingWalletAddressColumn) throw err;

    await ensureAgentWalletAddressColumn(requestId);
    agent = await prisma.agent.create({ data: agentCreateData });
  }

  console.log(`[generate-bot] [${requestId}] Saved agent: ${agent.id} with ${normalizedFiles.length} files`);
  return agent.id;
}