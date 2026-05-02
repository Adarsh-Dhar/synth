import "dotenv/config";
import axios from "axios";

type ProtocolName = "kamino" | "marginfi";

type JsonRecord = Record<string, unknown>;

interface ProtocolApy {
  protocol: ProtocolName;
  supplyApyPct: number;
  fetchedAt: string;
  sourceUrl: string;
}

const SIMULATION_MODE = String(process.env.SIMULATION_MODE ?? "true") !== "false";
const POLL_INTERVAL_MS = Number(process.env.POLL_INTERVAL_MS ?? "60000");
const REBALANCE_THRESHOLD_PCT = Number(process.env.REBALANCE_THRESHOLD_PCT ?? "1.5");
const NETWORK = String(process.env.SOLANA_NETWORK ?? "mainnet-beta");
const WALLET = String(process.env.USER_WALLET_ADDRESS ?? "").trim();
const USDC_MINT = String(process.env.TOKEN_MINT_ADDRESS ?? "").trim();

const KAMINO_USDC_APY_URL = String(
  process.env.KAMINO_USDC_APY_URL ?? "https://api.kamino.finance/v1/kamino-market/USDC/reserves",
).trim();
const MARGINFI_USDC_APY_URL = String(
  process.env.MARGINFI_USDC_APY_URL ?? "https://api.marginfi.com/v1/markets",
).trim();
const KAMINO_API_BASE_URL = String(process.env.KAMINO_API_BASE_URL ?? "https://api.kamino.finance").trim();
const KAMINO_KVAULT_ADDRESS = String(process.env.KAMINO_KVAULT_ADDRESS ?? "").trim();
const KAMINO_WITHDRAW_SHARES = String(process.env.KAMINO_WITHDRAW_SHARES ?? "all").trim();
const USDC_DECIMALS = Number(process.env.USDC_DECIMALS ?? "6");
const SOL_MINT_ADDRESS = String(process.env.SOL_MINT_ADDRESS ?? "").trim();
const MAX_CYCLES = Number(process.env.MAX_CYCLES ?? (SIMULATION_MODE ? "1" : "0"));
const SIMULATION_USE_LIVE_APY_FEEDS = String(process.env.SIMULATION_USE_LIVE_APY_FEEDS ?? "false") === "true";
const SIMULATION_KAMINO_APY_PCT = Number(process.env.SIMULATION_KAMINO_APY_PCT ?? "11.0");
const SIMULATION_MARGINFI_APY_PCT = Number(process.env.SIMULATION_MARGINFI_APY_PCT ?? "7.0");

const MCP_GATEWAY_URL = String(process.env.MCP_GATEWAY_URL ?? "").trim();
const SOLANA_KEY = String(process.env.SOLANA_KEY ?? "").trim();
const SETUP_SWAP_ON_START = String(process.env.SETUP_SWAP_ON_START ?? "false") === "true";
const SETUP_SWAP_LAMPORTS = BigInt(process.env.SETUP_SWAP_LAMPORTS ?? "100000000000");

let inFlight = false;
let shutdownRequested = false;
let timer: NodeJS.Timeout | undefined;
let completedCycles = 0;
let currentProtocol: ProtocolName =
  String(process.env.CURRENT_USDC_PROTOCOL ?? "kamino").toLowerCase() === "marginfi"
    ? "marginfi"
    : "kamino";

function normalizeBase(raw: string): string {
  return String(raw).trim().replace(/\/+$/, "");
}

function candidateUrls(base: string, server: string, tool: string): string[] {
  const withMcp = /\/mcp$/i.test(base) ? base : `${base}/mcp`;
  const without = withMcp.replace(/\/mcp$/i, "");
  return [`${withMcp}/${server}/${tool}`, `${without}/${server}/${tool}`];
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function callMcpTool(server: string, tool: string, args: JsonRecord): Promise<JsonRecord> {
  if (!MCP_GATEWAY_URL) {
    throw new Error("MCP_GATEWAY_URL is missing.");
  }

  const base = normalizeBase(MCP_GATEWAY_URL);
  const urls = candidateUrls(base, server, tool);
  let lastError = "unknown";

  for (let attempt = 1; attempt <= 3; attempt += 1) {
    for (const url of urls) {
      try {
        const resp = await axios.post(url, args, {
          timeout: 10_000,
          headers: {
            "Content-Type": "application/json",
            "ngrok-skip-browser-warning": "true",
            ...(SOLANA_KEY ? { "x-session-key": SOLANA_KEY } : {}),
          },
        });
        return (resp.data ?? {}) as JsonRecord;
      } catch (err) {
        const maybe = err as { response?: { status?: number; data?: unknown }; message?: string };
        const status = maybe.response?.status ?? 0;
        lastError = `${status}: ${JSON.stringify(maybe.response?.data ?? maybe.message ?? String(err))}`;
        if (status === 404) {
          continue;
        }
        break;
      }
    }
    if (attempt < 3) {
      await sleep(300 * attempt);
    }
  }

  throw new Error(`MCP ${server}/${tool} failed: ${lastError}`);
}

function tryReadNumber(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) {
    return v;
  }
  if (typeof v === "string") {
    const parsed = Number(v);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function findFirstNumeric(obj: unknown, keys: string[]): number | null {
  if (!obj) {
    return null;
  }

  if (Array.isArray(obj)) {
    for (const item of obj) {
      const found = findFirstNumeric(item, keys);
      if (found !== null) {
        return found;
      }
    }
    return null;
  }

  if (typeof obj !== "object") {
    return null;
  }

  const rec = obj as JsonRecord;
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(rec, key)) {
      const value = tryReadNumber(rec[key]);
      if (value !== null) {
        return value;
      }
    }
  }

  for (const value of Object.values(rec)) {
    const found = findFirstNumeric(value, keys);
    if (found !== null) {
      return found;
    }
  }

  return null;
}

function normalizePercent(value: number): number {
  if (value > 0 && value < 1) {
    return value * 100;
  }
  return value;
}

function formatUiAmountFromAtomic(amountAtomic: bigint, decimals: number): string {
  const safeDecimals = Number.isFinite(decimals) && decimals >= 0 ? Math.floor(decimals) : 0;
  const base = 10n ** BigInt(safeDecimals);
  const whole = amountAtomic / base;
  const frac = amountAtomic % base;
  if (frac === 0n || safeDecimals === 0) {
    return whole.toString();
  }
  const fracStr = frac.toString().padStart(safeDecimals, "0").replace(/0+$/, "");
  return `${whole.toString()}.${fracStr}`;
}

function parseKaminoEncodedTransaction(payload: unknown): string | null {
  if (!payload || typeof payload !== "object") {
    return null;
  }
  const rec = payload as JsonRecord;
  const direct = rec.transaction ?? rec.tx;
  if (typeof direct === "string" && direct.trim().length > 0) {
    return direct.trim();
  }
  const data = rec.data;
  if (data && typeof data === "object") {
    const tx = (data as JsonRecord).transaction ?? (data as JsonRecord).tx;
    if (typeof tx === "string" && tx.trim().length > 0) {
      return tx.trim();
    }
  }
  return null;
}

async function fetchJsonWithRetry(url: string): Promise<unknown> {
  let lastErr = "unknown";
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const resp = await axios.get(url, { timeout: 8_000 });
      return resp.data;
    } catch (err) {
      lastErr = err instanceof Error ? err.message : String(err);
      if (attempt < 3) {
        await sleep(250 * attempt);
      }
    }
  }
  throw new Error(`Failed to fetch ${url}: ${lastErr}`);
}

async function fetchKaminoApy(): Promise<ProtocolApy | null> {
  try {
    const data = await fetchJsonWithRetry(KAMINO_USDC_APY_URL);
    const apy = findFirstNumeric(data, ["supplyApy", "supplyAPY", "supplyApr", "apr", "apy"]);
    if (apy === null) {
      console.warn("[yield] Kamino APY unavailable in response shape.");
      return null;
    }
    return {
      protocol: "kamino",
      supplyApyPct: normalizePercent(apy),
      fetchedAt: new Date().toISOString(),
      sourceUrl: KAMINO_USDC_APY_URL,
    };
  } catch (err) {
    console.warn("[yield] Kamino APY fetch failed:", err instanceof Error ? err.message : String(err));
    return null;
  }
}

async function fetchMarginfiApy(): Promise<ProtocolApy | null> {
  try {
    const data = await fetchJsonWithRetry(MARGINFI_USDC_APY_URL);
    const apy = findFirstNumeric(data, ["lendingApy", "supplyApy", "apy", "apr", "lendApy"]);
    if (apy === null) {
      console.warn("[yield] Marginfi APY unavailable in response shape.");
      return null;
    }
    return {
      protocol: "marginfi",
      supplyApyPct: normalizePercent(apy),
      fetchedAt: new Date().toISOString(),
      sourceUrl: MARGINFI_USDC_APY_URL,
    };
  } catch (err) {
    console.warn("[yield] Marginfi APY fetch failed:", err instanceof Error ? err.message : String(err));
    return null;
  }
}

export async function fetch_lending_apys(): Promise<ProtocolApy[]> {
  if (SIMULATION_MODE && !SIMULATION_USE_LIVE_APY_FEEDS) {
    return [
      {
        protocol: "kamino",
        supplyApyPct: SIMULATION_KAMINO_APY_PCT,
        fetchedAt: new Date().toISOString(),
        sourceUrl: "simulation://kamino",
      },
      {
        protocol: "marginfi",
        supplyApyPct: SIMULATION_MARGINFI_APY_PCT,
        fetchedAt: new Date().toISOString(),
        sourceUrl: "simulation://marginfi",
      },
    ];
  }

  const [kamino, marginfi] = await Promise.all([fetchKaminoApy(), fetchMarginfiApy()]);
  return [kamino, marginfi].filter((v): v is ProtocolApy => v !== null);
}

async function getUsdcBalance(): Promise<bigint> {
  const response = await callMcpTool("solana", "get_token_balance", {
    network: NETWORK,
    owner: WALLET,
    mint: USDC_MINT,
  });
  const serialized = JSON.stringify(response);
  const matched = serialized.match(/"amount"\s*:\s*"(\d+)"/) ?? serialized.match(/"balance"\s*:\s*"?(\d+)"?/);
  return matched ? BigInt(matched[1]) : 0n;
}

async function buildKaminoEarnDepositTx(amountAtomic: bigint): Promise<string> {
  if (!KAMINO_KVAULT_ADDRESS) {
    throw new Error("KAMINO_KVAULT_ADDRESS is required for Kamino deposits.");
  }

  const amount = formatUiAmountFromAtomic(amountAtomic, USDC_DECIMALS);
  const url = `${KAMINO_API_BASE_URL.replace(/\/+$/, "")}/ktx/kvault/deposit`;
  const resp = await axios.post(
    url,
    {
      wallet: WALLET,
      kvault: KAMINO_KVAULT_ADDRESS,
      amount,
    },
    {
      timeout: 12_000,
      headers: { "Content-Type": "application/json" },
    },
  );

  const encoded = parseKaminoEncodedTransaction(resp.data);
  if (!encoded) {
    throw new Error("Kamino deposit response did not include a base64 transaction.");
  }
  return encoded;
}

async function buildKaminoEarnWithdrawTx(): Promise<string> {
  if (!KAMINO_KVAULT_ADDRESS) {
    throw new Error("KAMINO_KVAULT_ADDRESS is required for Kamino withdrawals.");
  }

  const url = `${KAMINO_API_BASE_URL.replace(/\/+$/, "")}/ktx/kvault/withdraw`;
  const resp = await axios.post(
    url,
    {
      wallet: WALLET,
      kvault: KAMINO_KVAULT_ADDRESS,
      shares: KAMINO_WITHDRAW_SHARES || "all",
    },
    {
      timeout: 12_000,
      headers: { "Content-Type": "application/json" },
    },
  );

  const encoded = parseKaminoEncodedTransaction(resp.data);
  if (!encoded) {
    throw new Error("Kamino withdraw response did not include a base64 transaction.");
  }
  return encoded;
}

async function submitSerializedTransaction(rawBase64: string): Promise<void> {
  const result = await callMcpTool("solana", "send_raw_transaction", {
    network: NETWORK,
    raw: rawBase64,
  });
  console.log("[yield] send_raw_transaction response:", JSON.stringify(result));
}

async function setupSwapToUsdc(): Promise<void> {
  if (!SETUP_SWAP_ON_START) {
    return;
  }

  if (!SOL_MINT_ADDRESS) {
    throw new Error("SETUP_SWAP_ON_START=true requires SOL_MINT_ADDRESS");
  }

  console.log(`[yield] setup trade: swapping ${SETUP_SWAP_LAMPORTS.toString()} lamports SOL to USDC via Jupiter MCP`);
  await callMcpTool("jupiter", "execute_swap", {
    network: NETWORK,
    userWallet: WALLET,
    inputMint: SOL_MINT_ADDRESS,
    outputMint: USDC_MINT,
    amount: SETUP_SWAP_LAMPORTS.toString(),
    slippageBps: 50,
  });
}

async function executeMigration(targetProtocol: ProtocolName, reason: string): Promise<boolean> {
  console.log(`[yield][reasoning] ${reason}`);
  const usdcBalance = await getUsdcBalance();
  if (usdcBalance <= 0n) {
    console.log("[yield] no USDC balance to migrate.");
    return false;
  }

  if (SIMULATION_MODE) {
    console.log(
      `[yield][simulation] would migrate ${usdcBalance.toString()} units from ${currentProtocol} to ${targetProtocol}`,
    );
    currentProtocol = targetProtocol;
    return true;
  }

  if (currentProtocol === "kamino") {
    try {
      console.log("[yield] attempting Kamino API withdraw tx path.");
      const withdrawRaw = await buildKaminoEarnWithdrawTx();
      await submitSerializedTransaction(withdrawRaw);
    } catch (err) {
      console.warn(
        "[yield] Kamino API withdraw path failed, falling back to solana_transaction:",
        err instanceof Error ? err.message : String(err),
      );
      await callMcpTool("solana", "solana_transaction", {
        network: NETWORK,
        action: "withdraw_usdc_supply",
        protocol: currentProtocol,
        wallet: WALLET,
        mint: USDC_MINT,
        amount: usdcBalance.toString(),
      });
    }
  } else {
    await callMcpTool("solana", "solana_transaction", {
      network: NETWORK,
      action: "withdraw_usdc_supply",
      protocol: currentProtocol,
      wallet: WALLET,
      mint: USDC_MINT,
      amount: usdcBalance.toString(),
    });
  }

  if (targetProtocol === "kamino") {
    try {
      console.log("[yield] attempting Kamino API deposit tx path.");
      const depositRaw = await buildKaminoEarnDepositTx(usdcBalance);
      await submitSerializedTransaction(depositRaw);
    } catch (err) {
      console.warn(
        "[yield] Kamino API deposit path failed, falling back to solana_transaction:",
        err instanceof Error ? err.message : String(err),
      );
      await callMcpTool("solana", "solana_transaction", {
        network: NETWORK,
        action: "deposit_usdc_supply",
        protocol: targetProtocol,
        wallet: WALLET,
        mint: USDC_MINT,
        amount: usdcBalance.toString(),
      });
    }
  } else {
    await callMcpTool("solana", "solana_transaction", {
      network: NETWORK,
      action: "deposit_usdc_supply",
      protocol: targetProtocol,
      wallet: WALLET,
      mint: USDC_MINT,
      amount: usdcBalance.toString(),
    });
  }

  currentProtocol = targetProtocol;
  console.log(`[yield] migration complete: now allocated to ${currentProtocol}`);
  return true;
}

function pickBest(apys: ProtocolApy[]): ProtocolApy | null {
  if (apys.length === 0) {
    return null;
  }
  return [...apys].sort((a, b) => b.supplyApyPct - a.supplyApyPct)[0];
}

async function runCycle(): Promise<void> {
  if (inFlight || shutdownRequested) {
    return;
  }

  inFlight = true;
  try {
    const apys = await fetch_lending_apys();
    if (apys.length < 2) {
      console.log("[yield] skipped cycle: APY data incomplete.");
      return;
    }

    const byProtocol = new Map(apys.map((row) => [row.protocol, row]));
    const current = byProtocol.get(currentProtocol);
    const best = pickBest(apys);

    if (!current || !best) {
      console.log("[yield] skipped cycle: unable to determine current/best APY.");
      return;
    }

    const delta = best.supplyApyPct - current.supplyApyPct;
    console.log(
      `[yield] current=${current.protocol}(${current.supplyApyPct.toFixed(3)}%) best=${best.protocol}(${best.supplyApyPct.toFixed(3)}%) delta=${delta.toFixed(3)}%`,
    );

    if (best.protocol !== current.protocol && delta >= REBALANCE_THRESHOLD_PCT) {
      const reason =
        `Competing protocol ${best.protocol} APY (${best.supplyApyPct.toFixed(3)}%) ` +
        `is >= ${REBALANCE_THRESHOLD_PCT}% above ${current.protocol} (${current.supplyApyPct.toFixed(3)}%).`; 
      await executeMigration(best.protocol, reason);
      return;
    }

    console.log("[yield] no rebalance: threshold not met.");
  } catch (err) {
    console.error("[yield] cycle failed:", err instanceof Error ? err.message : String(err));
  } finally {
    inFlight = false;
  }
}

async function main(): Promise<void> {
  if (!WALLET || !USDC_MINT) {
    throw new Error("Missing required env vars: USER_WALLET_ADDRESS and TOKEN_MINT_ADDRESS");
  }

  console.log(
    `[yield] starting sweeper network=${NETWORK} poll=${POLL_INTERVAL_MS}ms threshold=${REBALANCE_THRESHOLD_PCT}% simulation=${SIMULATION_MODE}`,
  );

  await setupSwapToUsdc();
  await runCycle();

  completedCycles = 1;

  if (MAX_CYCLES === 1) {
    shutdown("completed single simulation cycle");
    return;
  }

  timer = setInterval(() => {
    if (MAX_CYCLES > 0 && completedCycles >= MAX_CYCLES) {
      shutdown("reached max cycles");
      return;
    }

    completedCycles += 1;
    void runCycle();
  }, POLL_INTERVAL_MS);
}

function shutdown(signal: string): void {
  shutdownRequested = true;
  if (timer) {
    clearInterval(timer);
  }
  console.log(`[yield] received ${signal}, shutdown complete.`);
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

void main().catch((err) => {
  console.error("[yield] fatal:", err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
