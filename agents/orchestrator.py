"""
orchestrator.py  (v5 — Copilot ReAct Edition)

Meta-Agent — Solana-native DeFi bot generator with copilot-style planning.

Pipeline:
  build_bot_copilot(prompt, session_id)
    └── CopilotPlannerAgent.start_session(prompt)   ← ReAct loop
          ├── think  → plan what we need
          ├── ask_user  → pause & wait for clarification
          ├── query_onchain → verify wallet/mint via MCP
          ├── emit_plan → show architecture to user
          └── finish → hand enriched prompt to code generator

  continue_copilot(state, user_reply)
    └── CopilotPlannerAgent.continue_session(state, reply)  ← resume loop

Legacy single-shot:
  build_bot(prompt) → direct generation (no interactive planning)
"""

import os
import re
import json
import time
import logging
import tempfile
import subprocess
from concurrent.futures import ThreadPoolExecutor, TimeoutError as FuturesTimeoutError
from pathlib import Path
from typing import Any, Dict, List, Optional

from dotenv import load_dotenv
import httpx
import asyncio

from mcp_client import MultiMCPClient
from planner import (
    PlannerAgent,
    PlannerState,
    SolanaMCPClient,
    summarise_mcp_result,
    extract_resolved_address,
)
from copilot_planner import (
    CopilotPlannerAgent,
    CopilotState,
    build_yield_sweeper_enriched_prompt,
)

_BASE_DIR = Path(__file__).resolve().parent
load_dotenv(_BASE_DIR / ".env")
load_dotenv(_BASE_DIR / ".env.local", override=True)

logger = logging.getLogger(__name__)

LLM_TIMEOUT_SECONDS  = int(os.environ.get("META_AGENT_LLM_TIMEOUT_SECONDS", "240"))
LLM_MAX_RETRIES      = int(os.environ.get("META_AGENT_LLM_MAX_RETRIES", "2"))
LLM_RETRY_BASE_DELAY = float(os.environ.get("META_AGENT_LLM_RETRY_BASE_DELAY_SECONDS", "0.6"))
PLANNER_MAX_LOOPS    = int(os.environ.get("PLANNER_MAX_LOOPS", "4"))
PLANNER_ENABLED      = os.environ.get("PLANNER_ENABLED", "true").lower() != "false"
COPILOT_ENABLED      = os.environ.get("COPILOT_ENABLED", "true").lower() != "false"
JUPITER_DOCS_MCP_URL = os.environ.get("JUPITER_DOCS_MCP_URL", "http://127.0.0.1:5001").rstrip("/")
JUPITER_DOCS_TIMEOUT_SECONDS = float(os.environ.get("JUPITER_DOCS_TIMEOUT_SECONDS", "8"))
JUPITER_DOCS_MAX_CHARS = int(os.environ.get("JUPITER_DOCS_MAX_CHARS", "4000"))
CONTEXT_INJECTION_MAX_CHARS = int(os.environ.get("CONTEXT_INJECTION_MAX_CHARS", "12000"))


def _log(level: str, message: str, trace_id: Optional[str] = None) -> None:
    prefix = f"[meta-agent] [{level}]"
    if trace_id:
        prefix += f" [{trace_id}]"
    print(f"{prefix} {message}")


# ─── MCP Bridge — injected into every generated bot ──────────────────────────

MCP_BRIDGE_CONTENT = r'''
import "dotenv/config";
import axios from "axios";

const MCP_GATEWAY_URL = process.env.MCP_GATEWAY_URL ?? "";
const SOLANA_KEY = process.env.SOLANA_KEY ?? "";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeBase(raw: string): string {
  return String(raw || "").trim().replace(/\/+$/, "");
}

function candidateUrls(base: string, server: string, tool: string): string[] {
  const withMcp = /\/mcp$/i.test(base) ? base : base + "/mcp";
  const without = withMcp.replace(/\/mcp$/i, "");
  return [`${withMcp}/${server}/${tool}`, `${without}/${server}/${tool}`];
}

export async function callMcpTool(
  server: string,
  tool: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  const key = SOLANA_KEY.trim();
  if (server === "solana" && tool === "send_raw_transaction" && !key) {
    throw new Error("SOLANA_KEY missing — cannot send transactions.");
  }
  const base = normalizeBase(MCP_GATEWAY_URL);
  if (!base) throw new Error("MCP_GATEWAY_URL not configured.");

  const urls = candidateUrls(base, server, tool);
  let lastError = "unknown";

  for (let attempt = 1; attempt <= 3; attempt++) {
    for (const url of urls) {
      try {
        const resp = await axios.post(url, args, {
          headers: {
            "Content-Type": "application/json",
            ...(key ? { "x-session-key": key } : {}),
            "ngrok-skip-browser-warning": "true",
          },
          timeout: 10_000,
        });
        const data = resp.data;
        const result = (data as any)?.result;
        if (result?.isError) {
          const detail = Array.isArray(result.content) && result.content.length > 0
            ? String((result.content[0] as any).text ?? JSON.stringify(result.content))
            : JSON.stringify(result.content ?? data);
          throw new Error(`MCP error: ${detail}`);
        }
        return data;
      } catch (err) {
        const status = (err as any)?.response?.status ?? 0;
        lastError = `${status} — ${(err as any)?.response?.data ?? (err instanceof Error ? err.message : String(err))}`;
        if (status === 404) continue;
        break;
      }
    }
    if (attempt < 3) await sleep(400 * attempt);
  }
  throw new Error(`MCP ${server}/${tool} failed after retries: ${lastError}`);
}

export async function getSolBalance(
  network: string,
  walletAddress: string,
): Promise<bigint> {
  try {
    const data = await callMcpTool("solana", "get_balance", { network, address: walletAddress });
    const str = JSON.stringify(data ?? {});
    const m = str.match(/"lamports"\s*:\s*(\d+)/) ?? str.match(/"balance"\s*:\s*"?(\d+)"?/);
    return m ? BigInt(m[1]) : 0n;
  } catch (err) {
    console.warn("[MCP] getSolBalance failed:", err instanceof Error ? err.message : String(err));
    return 0n;
  }
}

export async function getTokenBalance(
  network: string,
  walletAddress: string,
  mint: string,
): Promise<bigint> {
  try {
    const data = await callMcpTool("solana", "get_token_balance", { network, owner: walletAddress, mint });
    const str = JSON.stringify(data ?? {});
    const m = str.match(/"amount"\s*:\s*"(\d+)"/) ?? str.match(/"balance"\s*:\s*"?(\d+)"?/);
    return m ? BigInt(m[1]) : 0n;
  } catch (err) {
    console.warn("[MCP] getTokenBalance failed:", err instanceof Error ? err.message : String(err));
    return 0n;
  }
}

export async function getGoldRushTokenBalances(
    network: string,
    walletAddress: string,
): Promise<unknown> {
    return callMcpTool("solana", "goldrush_token_balances", {
        network,
        wallet: walletAddress,
    });
}

export async function callMagicBlockPrivateTransfer(args: {
    network: string;
    from: string;
    to: string;
    mint: string;
    amount: string;
}): Promise<unknown> {
    return callMcpTool("solana", "magicblock_transfer", args);
}

export async function callUmbraShield(args: {
    network: string;
    wallet: string;
    mint: string;
    amount: string;
}): Promise<unknown> {
    return callMcpTool("solana", "umbra_shield", args);
}

export async function callUmbraTransfer(args: {
    network: string;
    sender: string;
    recipient: string;
    mint: string;
    amount: string;
}): Promise<unknown> {
    return callMcpTool("solana", "umbra_transfer", args);
}
'''.lstrip("\n")

SNS_RESOLVER_CONTENT = r'''
import { callMcpTool } from "./mcp_bridge.js";
import "dotenv/config";

const _cache = new Map<string, string>();

export function isSolDomain(value: string): boolean {
  return /^[a-z0-9_-]+\.sol$/i.test(String(value ?? "").trim());
}

export async function resolveAddress(nameOrAddress: string): Promise<string> {
  const v = String(nameOrAddress ?? "").trim();
  if (!isSolDomain(v)) return v;

  const key = v.toLowerCase();
  const cached = _cache.get(key);
  if (cached) return cached;

  const resp = await callMcpTool("solana", "resolve_sns", {
        network: String(process.env.SOLANA_NETWORK ?? "mainnet-beta"),
    name: key,
  });

  const str = JSON.stringify(resp ?? {});
  const m = str.match(/"(?:address|owner|resolved)"\s*:\s*"([1-9A-HJ-NP-Za-km-z]{32,44})"/);
  if (!m) throw new Error(`SNS: no address found for '${v}'`);

  _cache.set(key, m[1]);
  return m[1];
}
'''.lstrip("\n")


# ─── Intent Classifier ────────────────────────────────────────────────────────

CLASSIFIER_SYSTEM = """\
You are a Solana DeFi bot intent classifier.
Respond with a valid JSON object only:

{
  "chain": "solana",
  "network": "mainnet-beta",
  "strategy": "arbitrage" | "yield_sweeper" | "liquidation" | "sniping" | "dca" | "grid" | "whale_mirror" | "sentiment" | "custom_utility" | "unknown",
  "mcps": ["solana"],
  "bot_name": "<human-readable name>",
  "requires_openai": false
}

yield / sweep / consolidate / Kamino / sUSDe → "yield_sweeper"
arb / spread / flash → "arbitrage"
liquidation / health-factor → "liquidation"
snipe / new-token / launch → "sniping"
dca / dollar-cost → "dca"
sentiment / social / news → "sentiment", requires_openai: true
everything else → "custom_utility"
"""


def _normalize_strategy(s: str) -> str:
    v = str(s or "").strip().lower()
    return {
        "yield": "yield_sweeper",
        "yield-sweeper": "yield_sweeper",
        "sweep": "yield_sweeper",
        "arb": "arbitrage",
        "spread_scanner": "arbitrage",
        "flash": "arbitrage",
        "liquidation_sniper": "liquidation",
        "snipe": "sniping",
        "token_sniper": "sniping",
        "dollar_cost": "dca",
        "custom": "custom_utility",
    }.get(v, v or "unknown")


def _normalize_filepath(raw: object) -> str:
    p = str(raw or "").strip().replace("\\", "/")
    p = re.sub(r"^[./]+", "", p)
    if not p:
        return ""
    lower = p.lower()
    base = lower.split("/")[-1]
    aliases = {
        "package.json": "package.json",
        "index.ts": "src/index.ts",
        "main.ts": "src/index.ts",
        "mcp_bridge.ts": "src/mcp_bridge.ts",
        "sns_resolver.ts": "src/sns_resolver.ts",
    }
    return aliases.get(lower) or aliases.get(base) or p


# ─── Generator System Prompt ──────────────────────────────────────────────────
# FIX: Replaced vague "handle execution" instruction with explicit architectural
# boundary rules and exact signing boilerplate. The LLM was hallucinating
# callMcpTool("jupiter","execute_swap") because no hard boundary existed.

GENERATOR_SYSTEM = """\
You are an expert Solana bot engineer. Generate production-ready TypeScript for the Agentia platform.

Respond with valid JSON only (no markdown):

{
  "thoughts": "<one paragraph: architecture rationale>",
  "files": [
    {"filepath": "package.json", "content": "..."},
    {"filepath": "src/index.ts",  "content": "..."}
  ]
}

Generate these 2 files in this order:
  1. package.json
  2. src/index.ts

Additional files src/mcp_bridge.ts and src/sns_resolver.ts are injected automatically.

Import from bridge: import { callMcpTool, getSolBalance, getTokenBalance } from './mcp_bridge.js';
Import from resolver (only if needed): import { resolveAddress, isSolDomain } from './sns_resolver.js';

══════════════════════════════════════════════════════════
CRITICAL ARCHITECTURAL BOUNDARY — READ BEFORE WRITING CODE
══════════════════════════════════════════════════════════

The Jupiter MCP Server is READ-ONLY context and quote retrieval ONLY.
It does NOT have access to the user's private key and CANNOT sign transactions.

FORBIDDEN — never write these in generated code:
  ✗ callMcpTool("jupiter", "execute_swap", ...)   ← does not exist, will crash at runtime
  ✗ callMcpTool("jupiter", "swap", ...)           ← does not exist
  ✗ Any MCP call that implies transaction signing or submission

REQUIRED swap execution flow — always use this exact pattern:
  Step 1: GET https://quote-api.jup.ag/v6/quote  → quoteResponse
  Step 2: POST https://quote-api.jup.ag/v6/swap  → { swapTransaction: "<base64>" }
  Step 3: Sign and send locally with @solana/web3.js:

    import { Connection, Keypair, VersionedTransaction } from "@solana/web3.js";

    const connection = new Connection(
      process.env.SOLANA_RPC_URL ?? "https://api.mainnet-beta.solana.com"
    );
    const secretKey = new Uint8Array(
      JSON.parse(process.env.SOLANA_KEY ?? "[]")
    );
    const wallet = Keypair.fromSecretKey(secretKey);

    // After receiving swapTransaction from Jupiter /swap endpoint:
    const swapTransactionBuf = Buffer.from(swapTransaction, "base64");
    const transaction = VersionedTransaction.deserialize(swapTransactionBuf);
    transaction.sign([wallet]);
    const txid = await connection.sendRawTransaction(
      transaction.serialize(),
      { skipPreflight: true, maxRetries: 2 }
    );
    console.log("Swap executed:", txid);

The MCP bridge (callMcpTool) is ONLY used for:
  • callMcpTool("solana", "get_balance", ...)         — read SOL balance
    • callMcpTool("solana", "get_token_balance", ...)   — read SPL token balance (owner + mint, summed raw amount)
  • callMcpTool("solana", "get_account_info", ...)    — read account data
  • callMcpTool("solana", "resolve_sns", ...)         — resolve .sol domains
  • callMcpTool("solana", "send_raw_transaction", ...) — submit already-signed tx

════════════════════════════════════════
CORE RULES
════════════════════════════════════════
1. TypeScript + Node.js (ESM). package.json sets "type": "module".
2. "start" script is: "tsx src/index.ts"
3. Dependencies: axios ^1.7.4, dotenv ^16.4.0, @solana/web3.js ^1.98.0, tsx (dev), typescript (dev), @types/node (dev).
4. Import "dotenv/config" at the very top of src/index.ts.
5. Use BigInt for all internal token balance math. When calling the Jupiter /quote API, you MUST pass the EXACT raw balance (as a string) retrieved from get_token_balance. Do not normalize decimals before fetching the quote.
6. SIMULATION_MODE = process.env.SIMULATION_MODE !== "false" (default true).
7. When SIMULATION_MODE is true, log the swap that would happen instead of executing it.
8. Use an inFlight boolean guard to prevent overlapping poll cycles.
9. Handle SIGINT / SIGTERM for graceful shutdown.
10. Addresses are read from process.env, not hardcoded.
11. Load .env CORRECTLY using explicit path resolution:
    import { config } from "dotenv";
    import { fileURLToPath } from "url";
    import { dirname, join } from "path";
    const __filename = fileURLToPath(import.meta.url);
    const botDir = dirname(dirname(__filename));
    config({ path: join(botDir, ".env") });
12. Log environment variables at startup for debugging.
13. Ensure MCP_GATEWAY_URL defaults to http://127.0.0.1:8001 if not set.
14. Include retry logic (3 attempts with exponential backoff) around Jupiter API calls.
15. Never call execSync, child_process, or any local CLI tool.
16. If the user requests a DCA, TWAP, or chunked execution strategy, you MUST use a finite loop (e.g., a for-loop based on the number of chunks). You MUST insert a randomized sleep interval (jitter) between each execution using await sleep(Math.floor(Math.random() * max) + min). NEVER use an infinite while(true) loop for a chunked strategy.
17. MINT ROUTING: Never set inputMint and outputMint to the same address. Unless explicitly instructed otherwise by the user, assume the inputMint is always USDC (EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v) and the outputMint is the user's target TOKEN_MINT_ADDRESS.
18. EXECUTION LIFECYCLE: If the user requests a finite execution strategy (e.g., "split into 5 chunks", "buy X times"), the main() function MUST execute exactly that many times and then gracefully exit using process.exit(0). DO NOT wrap finite strategies in a while(true) loop or setInterval. Daemon loops are ONLY for continuous monitoring strategies.
19. SWAP PAYLOAD: When making the POST request to the Jupiter /v6/swap endpoint, the JSON body MUST ALWAYS include "dynamicComputeUnitLimit": true and "prioritizationFeeLamports": { "autoMultiplier": 2 } to prevent mainnet transaction drops.

ENV VARS your bot should read:
  SOLANA_NETWORK, SOLANA_RPC_URL, SOLANA_KEY,
  USER_WALLET_ADDRESS, TOKEN_MINT_ADDRESS,
  POOL_ADDRESS, PROGRAM_ID,
  TRADE_AMOUNT_LAMPORTS, MIN_PROFIT_LAMPORTS,
  POLL_INTERVAL_MS (default 15000), SIMULATION_MODE
"""

DEMO_CONTEXT = """
=== DEMO-MODE YIELD SWEEPER CONTEXT (Kamino ↔ sUSDe) ===

EXACT MINT ADDRESSES (hardcoded, never ask):
    USDC:   EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v  (6 decimals)
    sUSDe:  G9W2WBKV3nJULX4kz47HCJ75jnVG4RYWZj5q5U5kXfz   (18 decimals)
    SOL:    So11111111111111111111111111111111111111112      (9 decimals)

JUPITER SWAP PATTERN — use axios to call Jupiter HTTP API directly, then sign locally:
    // Step 1: Get quote
    const quoteResp = await axios.get("https://quote-api.jup.ag/v6/quote", {
        params: {
            inputMint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
            outputMint: "G9W2WBKV3nJULX4kz47HCJ75jnVG4RYWZj5q5U5kXfz",
            // IMPORTANT: amount is the raw token balance (smallest units) as a string
            amount: usdcBalance.toString(),
            slippageBps: 50,
        },
        timeout: 10_000,
    });
    // Step 2: Get swap transaction
    const swapResp = await axios.post("https://quote-api.jup.ag/v6/swap", {
        quoteResponse: quoteResp.data,
        userPublicKey: WALLET,
        wrapAndUnwrapSol: true,
        dynamicComputeUnitLimit: true,
        prioritizationFeeLamports: {
            autoMultiplier: 2,
        },
    }, { timeout: 10_000 });
    // Step 3: Sign and send locally (SIMULATION_MODE check first)
    if (SIMULATION_MODE) {
        console.log("[sim] would execute swap, skipping signing");
    } else {
        const swapTransactionBuf = Buffer.from(swapResp.data.swapTransaction, "base64");
        const transaction = VersionedTransaction.deserialize(swapTransactionBuf);
        transaction.sign([wallet]);
        const txid = await connection.sendRawTransaction(
            transaction.serialize(), { skipPreflight: true, maxRetries: 2 }
        );
        console.log("Swap txid:", txid);
    }

APY FETCH PATTERN:
    async function fetchKaminoApy(): Promise<number> {
        const r = await axios.get(String(process.env.KAMINO_APY_URL ?? ""), {timeout: 8000});
        return extractFirstNumber(r.data, ["supplyApy","supplyAPY","apr","apy"]) ?? 0;
    }
    async function fetchSusdeApy(): Promise<number> {
        const r = await axios.get(String(process.env.SUSDE_APY_URL ?? ""), {timeout: 8000});
        return Number(r.data?.apy ?? r.data?.yield ?? 0);
    }

DECIMAL CONVERSION:
    const toUiUsdc = (raw: bigint) => Number(raw) / 1e6;
    const toUiSusde = (raw: bigint) => Number(raw) / 1e18;
"""


# ─── MetaAgent ────────────────────────────────────────────────────────────────

class MetaAgent:
    def __init__(self):
        token = os.environ.get("GITHUB_TOKEN") or os.environ.get("AZURE_AI_KEY")
        if not token:
            raise ValueError("No AI model credential found. Set GITHUB_TOKEN or AZURE_AI_KEY in agents/.env")

        endpoint = os.environ.get("GITHUB_MODEL_ENDPOINT", "https://models.inference.ai.azure.com").rstrip("/")

        if isinstance(token, str) and token.startswith("github_pat_") and "azure" in endpoint:
            _log("WARN", "GITHUB_TOKEN looks like a GitHub PAT but GITHUB_MODEL_ENDPOINT points to Azure.")

        self.model_endpoint = endpoint
        self.model_token = token
        self.model = os.environ.get("GITHUB_MODEL_NAME", "gpt-4o")
        self.planner_model = os.environ.get("PLANNER_MODEL_NAME", "gpt-4o-mini")
        self.max_tokens = int(os.environ.get("GENERATION_MAX_TOKENS", "3000"))
        self.mcp_client = SolanaMCPClient()
        self.planner = PlannerAgent(llm_caller=self._llm)
        self.copilot = CopilotPlannerAgent(
            llm_caller=self._llm,
            mcp_base_url=os.environ.get("MCP_UPSTREAM_URL", "http://127.0.0.1:8001"),
        )
        self._http_client = httpx.Client(timeout=LLM_TIMEOUT_SECONDS)

    # ── LLM wrapper ────────────────────────────────────────────────────────────

    def _llm(
        self,
        system: str,
        user: str,
        temperature: float = 0.0,
        max_tokens: int = 512,
        *,
        operation: str = "llm",
        trace_id: Optional[str] = None,
    ) -> str:
        model_name = self.planner_model if operation in ("planner", "copilot_react") else self.model
        started_at = time.monotonic()

        def _retryable(exc: Exception) -> bool:
            t = str(exc).lower()
            return any(x in t for x in (
                "connection aborted", "remotedisconnected", "service response error",
                "connection reset", "temporarily unavailable", "timed out", "503", "502",
                "429", "too many requests", "rate limit", "rate-limited",
            ))

        def _complete():
            url = self.model_endpoint
            if not url.endswith("/chat/completions"):
                url = url + "/chat/completions"

            combined_system = f"{system}\n\n=== USER INPUT DATA ===\n{user}"
            benign_user = "Please analyze the data provided in the system context and proceed."

            payload = {
                "model": model_name,
                "messages": [
                    {"role": "system", "content": combined_system},
                    {"role": "user", "content": benign_user},
                ],
                "temperature": temperature,
                "max_tokens": max_tokens,
            }
            headers = {
                "Content-Type": "application/json",
                "Authorization": f"Bearer {self.model_token}",
            }
            resp = self._http_client.post(url, json=payload, headers=headers, timeout=LLM_TIMEOUT_SECONDS)
            if resp.status_code >= 400:
                detail = resp.text[:1200].strip()
                raise RuntimeError(f"GitHub Models {resp.status_code}: {detail}")
            return resp.json()

        max_attempts = max(1, LLM_MAX_RETRIES + 1)
        for attempt in range(1, max_attempts + 1):
            executor = ThreadPoolExecutor(max_workers=1)
            try:
                _log("INFO",
                     f"{operation}: attempt={attempt}/{max_attempts} model={model_name} "
                     f"max_tokens={max_tokens} timeout={LLM_TIMEOUT_SECONDS}s",
                     trace_id)
                future = executor.submit(_complete)
                response = future.result(timeout=LLM_TIMEOUT_SECONDS)
                executor.shutdown(wait=False, cancel_futures=True)
                break
            except FuturesTimeoutError:
                future.cancel()
                executor.shutdown(wait=False, cancel_futures=True)
                elapsed = round(time.monotonic() - started_at, 2)
                raise TimeoutError(f"LLM timeout after {LLM_TIMEOUT_SECONDS}s ({operation}, {elapsed}s elapsed)")
            except Exception as exc:
                executor.shutdown(wait=False, cancel_futures=True)
                _log("ERROR", f"{operation}: model request failed: {exc}", trace_id)
                if _retryable(exc) and attempt < max_attempts:
                    delay = round(LLM_RETRY_BASE_DELAY * attempt, 2)
                    _log("WARN", f"{operation}: retrying in {delay}s ({exc})", trace_id)
                    time.sleep(delay)
                    continue
                raise

        content = None
        if isinstance(response, dict):
            choices = response.get("choices") or []
            if isinstance(choices, list) and len(choices) > 0:
                first = choices[0]
                if isinstance(first, dict):
                    msg = first.get("message")
                    if isinstance(msg, dict) and isinstance(msg.get("content"), str):
                        content = msg.get("content")
                    if content is None and isinstance(first.get("text"), str):
                        content = first.get("text")
        if content is None:
            content = str(response)
        elapsed = round(time.monotonic() - started_at, 2)
        _log("INFO", f"{operation}: done in {elapsed}s", trace_id)
        return content.strip() if isinstance(content, str) else str(content)

    # ── Copilot API (new) ──────────────────────────────────────────────────────

    async def build_bot_copilot_start(
        self,
        prompt: str,
        session_id: str,
        trace_id: Optional[str] = None,
    ) -> Dict[str, Any]:
        _log("INFO", f"copilot start session={session_id} chars={len(prompt)}", trace_id)
        state = self.copilot.start_session(prompt, session_id)
        return await self._process_copilot_state(state, trace_id)

    async def build_bot_copilot_continue(
        self,
        session_state: Dict[str, Any],
        user_reply: str,
        trace_id: Optional[str] = None,
    ) -> Dict[str, Any]:
        state = CopilotState(**session_state)
        _log("INFO", f"copilot continue session={state.session_id}", trace_id)
        state = self.copilot.continue_session(state, user_reply)
        return await self._process_copilot_state(state, trace_id)

    async def _process_copilot_state(
        self,
        state: CopilotState,
        trace_id: Optional[str] = None,
    ) -> Dict[str, Any]:
        state_dict = state.model_dump()

        if state.is_waiting_for_user:
            ask_step = next(
                (s for s in reversed(state.steps) if s.step_type == "ask_user"),
                None
            )
            question = ask_step.tool_args.get("question", "") if ask_step else state.pending_question or ""
            parameter = ask_step.tool_args.get("parameter_name", "") if ask_step else state.pending_parameter or ""
            examples = ask_step.tool_args.get("examples", []) if ask_step else []

            return {
                "status": "clarification_needed",
                "question": question,
                "parameter_name": parameter,
                "examples": examples,
                "session_state": state_dict,
                "steps": [s.model_dump() for s in state.steps],
                "confirmed_parameters": state.confirmed_parameters,
            }

        plan_step = next(
            (s for s in reversed(state.steps) if s.step_type == "emit_plan"),
            None
        )

        if state.is_complete and state.final_enriched_prompt:
            _log("INFO", f"copilot generating code strategy={state.strategy}", trace_id)

            enriched = state.final_enriched_prompt
            strategy = state.strategy or "custom_utility"

            if strategy == "yield_sweeper":
                enriched = build_yield_sweeper_enriched_prompt(state.confirmed_parameters)

            result = await self._generate_code_copilot(
                enriched_prompt=enriched,
                strategy=strategy,
                confirmed_parameters=state.confirmed_parameters,
                trace_id=trace_id,
            )

            result["steps"] = [s.model_dump() for s in state.steps]
            result["session_state"] = state_dict
            result["plan"] = plan_step.tool_args if plan_step else {}
            return result

        return {
            "status": "planning",
            "steps": [s.model_dump() for s in state.steps],
            "session_state": state_dict,
            "plan": plan_step.tool_args if plan_step else {},
            "confirmed_parameters": state.confirmed_parameters,
        }

    async def _generate_code_copilot(
        self,
        enriched_prompt: str,
        strategy: str,
        confirmed_parameters: Dict[str, str],
        trace_id: Optional[str] = None,
    ) -> Dict[str, Any]:
        network = confirmed_parameters.get("SOLANA_NETWORK", "mainnet-beta")

        jupiter_docs = await self._fetch_rag_context(enriched_prompt, strategy)
        chain_ctx = self._chain_context(network, strategy)
        params_txt = "\n".join(f"  {k}={v}" for k, v in confirmed_parameters.items())

        user_msg = (
            f"Strategy: {strategy}\n"
            f"Network: {network}\n"
            f"Confirmed parameters:\n{params_txt}\n\n"
            f"User intent: {enriched_prompt}\n\n"
        )

        if jupiter_docs:
            user_msg += f"=== JUPITER CONTEXT ===\n{jupiter_docs[:JUPITER_DOCS_MAX_CHARS]}\n\n"

        if strategy in ("yield_sweeper", "shielded_yield"):
            user_msg += DEMO_CONTEXT + "\n\n"

        user_msg += f"{chain_ctx}\n\nGenerate the 2 files now."

        _log("INFO", f"generator prompt chars={len(user_msg)}", trace_id)

        MAX_RETRIES = 2
        files: List[Dict[str, Any]] = []
        parsed: Dict[str, Any] = {}

        for attempt in range(MAX_RETRIES + 1):
            try:
                raw = self._llm(GENERATOR_SYSTEM, user_msg, temperature=0.1, max_tokens=self.max_tokens)
            except Exception as exc:
                _log("ERROR", f"Generator LLM failed attempt={attempt+1}: {exc}", trace_id)
                if attempt < MAX_RETRIES:
                    time.sleep(LLM_RETRY_BASE_DELAY * (attempt + 1))
                    continue
                return {"status": "error", "message": f"LLM generation failed: {exc}"}

            parsed = self._parse_json(raw)
            files = self._assemble_files(parsed.get("files", []), strategy)

            index_ts = next((f.get("content") for f in files if f.get("filepath") == "src/index.ts"), None)

            if not index_ts:
                break

            # Post-generation validation: reject hallucinated MCP swap calls
            hallucination_check = self._check_for_mcp_swap_hallucination(index_ts)
            if hallucination_check:
                _log("WARN", f"Hallucination detected on attempt {attempt+1}: {hallucination_check}", trace_id)
                if attempt < MAX_RETRIES:
                    user_msg = (
                        f"{user_msg}\n\n"
                        f"CRITICAL ERROR in your previous output: {hallucination_check}\n"
                        "You MUST use axios to call https://quote-api.jup.ag/v6/quote and "
                        "https://quote-api.jup.ag/v6/swap directly, then sign with @solana/web3.js. "
                        "callMcpTool('jupiter', 'execute_swap') does NOT exist. Fix and return full JSON."
                    )
                    continue

            # TypeScript syntax check
            with tempfile.TemporaryDirectory() as tmp:
                src_dir = os.path.join(tmp, "src")
                os.makedirs(src_dir, exist_ok=True)
                fp = os.path.join(src_dir, "index.ts")
                with open(fp, "w") as f_h:
                    f_h.write(str(index_ts))

                result = subprocess.run(
                    ["npx", "-y", "tsc", "--noEmit", "--target", "es2020", "--moduleResolution", "node", fp],
                    capture_output=True, text=True, check=False,
                )

                if result.returncode == 0:
                    break

                if attempt < MAX_RETRIES:
                    error_msg = (result.stdout + "\n" + result.stderr).strip()
                    user_msg = (
                        f"{user_msg}\n\n"
                        f"The code failed TypeScript validation:\n\n{error_msg[:800]}\n\n"
                        "Fix the errors and return the FULL updated JSON."
                    )

        intent = {
            "chain": "solana",
            "network": network,
            "strategy": strategy,
            "mcps": ["solana"],
            "bot_name": self._bot_name(strategy),
            "requires_openai": strategy == "sentiment",
            "collected_parameters": confirmed_parameters,
        }

        return {
            "status": "ready",
            "intent": intent,
            "output": {"thoughts": parsed.get("thoughts", ""), "files": files},
            "files": files,
        }

    # ── RAG context fetcher ────────────────────────────────────────────────────

    async def _fetch_rag_context(self, prompt: str, strategy: str) -> str:
        normalized = prompt.lower()
        needs_jupiter = strategy in {"arbitrage", "sniping", "dca", "grid", "whale_mirror", "yield_sweeper"} or \
                        any(t in normalized for t in ("jupiter", "swap", "quote", "trade"))

        mcp = MultiMCPClient()
        try:
            await mcp.connect_default_sessions()
        except Exception:
            pass

        jup_res = ""

        if needs_jupiter:
            try:
                jup_res = await mcp.call_tool("jupiter", "jupiter_docs", {"query": prompt})
            except Exception as exc:
                _log("WARN", f"Jupiter MCP docs failed: {exc}")

        try:
            await mcp.shutdown()
        except Exception:
            pass

        return str(jup_res or "")

    # ── Hallucination detector ─────────────────────────────────────────────────

    @staticmethod
    def _check_for_mcp_swap_hallucination(code: str) -> Optional[str]:
        """
        Detect the most common hallucination pattern: using callMcpTool to execute
        a Jupiter swap. Returns an error string if found, None if code is clean.
        """
        # Pattern: callMcpTool("jupiter", "execute_swap", ...)
        if re.search(r'callMcpTool\s*\(\s*["\']jupiter["\'].*["\']execute_swap["\']', code, re.DOTALL):
            return (
                "callMcpTool(\"jupiter\", \"execute_swap\") was used — this tool does not exist. "
                "Jupiter swaps must be executed via axios calls to quote-api.jup.ag/v6 "
                "and signed locally with @solana/web3.js VersionedTransaction."
            )

        # Pattern: callMcpTool("jupiter", "swap", ...)
        if re.search(r'callMcpTool\s*\(\s*["\']jupiter["\'].*["\']swap["\']', code, re.DOTALL):
            return (
                "callMcpTool(\"jupiter\", \"swap\") was used — this tool does not exist. "
                "Use axios to call https://quote-api.jup.ag/v6/swap directly."
            )

        return None

    # ── Planner orchestration (legacy) ─────────────────────────────────────────

    async def orchestrate_bot_creation_stream(
        self,
        user_msg: str,
        trace_id: Optional[str] = None,
    ):
        start_time = time.time()
        _log("INFO", "orchestrate_bot_creation_stream START", trace_id)

        def emit(payload: Dict[str, Any]) -> str:
            status = payload.get("status") or payload.get("error") or "unknown"
            try:
                _log("DEBUG", f"EMIT status={status} keys={list(payload.keys())}", trace_id)
            except Exception:
                pass
            return f"data: {json.dumps(payload)}\n\n"

        yield emit({"status": "analyzing_intent", "message": "Analyzing strategy intent..."})
        await asyncio.sleep(0.1)

        history = [{"role": "user", "content": user_msg}]
        plan: Optional[PlannerState] = None
        for loop_idx in range(PLANNER_MAX_LOOPS):
            try:
                plan = self.planner.plan(history, trace_id=trace_id)
            except Exception as exc:
                _log("ERROR", f"Planner LLM failed: {exc}", trace_id)
                yield emit({"error": str(exc)})
                return

            _log("INFO",
                f"Plan: strategy={plan.strategy_type} ready={plan.is_ready_for_code_generation}",
                trace_id)

            vs = plan.verification_step
            if vs and vs.needs_mcp_query and vs.mcp_payload:
                purpose = vs.verification_purpose or "on-chain verification"
                try:
                    result = self.mcp_client.query(vs.mcp_payload)
                    summary = summarise_mcp_result(purpose, vs.mcp_payload, result)
                except Exception as exc:
                    summary = f"MCP Verification [{purpose}] FAILED: {exc}."
                history.append({"role": "system", "content": summary})
                continue

            if not plan.is_ready_for_code_generation:
                question = (
                    plan.clarifying_question_for_user
                    or "Could you provide more details about the tokens, pools, or addresses?"
                )
                yield emit({
                    "status": "clarification_needed",
                    "question": question,
                    "strategy_type": plan.strategy_type,
                    "missing_parameters": plan.missing_parameters,
                    "collected_parameters": plan.collected_parameters,
                })
                return

            break

        if not plan:
            yield emit({"error": "Planner did not return a usable plan."})
            return

        network = plan.collected_parameters.get("SOLANA_NETWORK", "mainnet-beta")
        intent = {
            "chain": "solana",
            "network": network,
            "strategy": plan.strategy_type,
            "mcps": ["solana"],
            "bot_name": self._bot_name(plan.strategy_type),
            "requires_openai": plan.strategy_type == "sentiment",
            "collected_parameters": plan.collected_parameters,
        }

        yield emit({"status": "fetching_context", "message": "Fetching SDK docs from MCP servers..."})

        jupiter_docs = await self._fetch_rag_context(user_msg, plan.strategy_type)

        enriched_prompt = f"{user_msg}\n\n"
        if jupiter_docs:
            enriched_prompt += f"=== JUPITER CONTEXT ===\n{jupiter_docs}\n\n"

        yield emit({"status": "generating_code", "message": "AI is writing TypeScript code..."})

        prompt_source = enriched_prompt
        final_files: List[Dict[str, Any]] = []
        final_warning: Optional[str] = None
        MAX_RETRIES = 2

        for attempt in range(MAX_RETRIES + 1):
            try:
                raw = self._llm(GENERATOR_SYSTEM, prompt_source, temperature=0.1, max_tokens=self.max_tokens)
            except Exception as exc:
                _log("ERROR", f"Generator LLM failed attempt={attempt+1}: {exc}", trace_id)
                if attempt < MAX_RETRIES:
                    time.sleep(LLM_RETRY_BASE_DELAY * (attempt + 1))
                    continue
                yield emit({"error": f"LLM generation failed: {exc}"})
                return

            parsed = self._parse_json(raw)
            final_files = self._assemble_files(parsed.get("files", []), plan.strategy_type)

            index_ts_content = next(
                (f.get("content") for f in final_files if f.get("filepath") == "src/index.ts"),
                None
            )
            if not index_ts_content:
                break

            # Post-generation hallucination check
            hallucination_check = self._check_for_mcp_swap_hallucination(index_ts_content)
            if hallucination_check and attempt < MAX_RETRIES:
                _log("WARN", f"Hallucination on attempt {attempt+1}: {hallucination_check}", trace_id)
                yield emit({"status": "self_healing", "message": "Fixing incorrect MCP usage..."})
                prompt_source = (
                    f"{enriched_prompt}\n\n"
                    f"CRITICAL ERROR: {hallucination_check}\n"
                    "Use axios to call https://quote-api.jup.ag/v6/quote and /swap directly, "
                    "then sign with @solana/web3.js VersionedTransaction. Return the FULL updated JSON."
                )
                continue

            yield emit({"status": "validating_syntax", "message": "Running TypeScript compiler..."})

            with tempfile.TemporaryDirectory() as temp_dir:
                src_dir = os.path.join(temp_dir, "src")
                os.makedirs(src_dir, exist_ok=True)
                file_path = os.path.join(src_dir, "index.ts")
                with open(file_path, "w") as handle:
                    handle.write(str(index_ts_content))

                result = subprocess.run(
                    ["npx", "-y", "tsc", "--noEmit", "--target", "es2020", "--moduleResolution", "node", file_path],
                    capture_output=True, text=True, check=False,
                )

                if result.returncode == 0:
                    yield emit({"status": "complete", "files": final_files, "plan": plan.model_dump(), "intent": intent})
                    return

                error_msg = (result.stdout + "\n" + result.stderr).strip()
                if attempt < MAX_RETRIES:
                    yield emit({"status": "self_healing", "message": "Syntax error caught. AI is self-healing..."})
                    prompt_source = (
                        f"{enriched_prompt}\n\n"
                        f"The code failed TypeScript validation:\n\n{error_msg[:1000]}\n\n"
                        "Fix the errors and return the FULL updated JSON."
                    )
                else:
                    final_warning = "Code generated with TypeScript errors."
                    break

        yield emit({"status": "complete", "files": final_files, "plan": plan.model_dump(), "intent": intent, "warning": final_warning})
        elapsed = round(time.time() - start_time, 2)
        _log("INFO", f"orchestrate_bot_creation_stream END elapsed={elapsed}s", trace_id)

    async def orchestrate_bot_creation(
        self,
        chat_history: List[Dict[str, str]],
        trace_id: Optional[str] = None,
    ) -> Dict[str, Any]:
        user_msg = chat_history[-1].get("content", "") if chat_history else ""
        final_payload: Optional[Dict[str, Any]] = None

        async for chunk in self.orchestrate_bot_creation_stream(user_msg, trace_id=trace_id):
            if not chunk.startswith("data:"):
                continue
            raw = chunk[5:].strip()
            if not raw:
                continue
            try:
                payload = json.loads(raw)
            except Exception:
                continue
            if payload.get("status") in {"complete", "clarification_needed", "error"} or payload.get("error"):
                final_payload = payload

        if not final_payload:
            return {"status": "error", "message": "Stream ended without a final payload."}
        if final_payload.get("error"):
            return {"status": "error", "message": str(final_payload.get("error"))}
        result = dict(final_payload)
        if result.get("status") == "complete":
            result["status"] = "ready"
        return result

    # ── Legacy generate ────────────────────────────────────────────────────────

    async def _generate_code_with_plan(
        self,
        plan: PlannerState,
        enriched_prompt: str,
        trace_id: Optional[str] = None,
    ) -> Dict[str, Any]:
        network = plan.collected_parameters.get("SOLANA_NETWORK", "mainnet-beta")
        intent = {
            "chain": "solana",
            "network": network,
            "strategy": plan.strategy_type,
            "mcps": ["solana"],
            "bot_name": self._bot_name(plan.strategy_type),
            "requires_openai": plan.strategy_type == "sentiment",
            "collected_parameters": plan.collected_parameters,
        }

        jupiter_docs = await self._fetch_rag_context(enriched_prompt, plan.strategy_type)

        combined = ""
        if jupiter_docs:
            combined += f"JUPITER DOCS CONTEXT (live MCP):\n{jupiter_docs[:JUPITER_DOCS_MAX_CHARS]}\n\n"

        if not combined:
            combined = "JUPITER DOCS CONTEXT: unavailable for this request.\n\n"

        if plan.strategy_type in ("yield_sweeper", "shielded_yield"):
            combined += DEMO_CONTEXT + "\n\n"

        params_txt = "\n".join(f"  {k}={v}" for k, v in plan.collected_parameters.items())
        user_msg = (
            f"Bot name: {intent['bot_name']}\n"
            f"Chain: solana | Network: {network}\n"
            f"Strategy: {plan.strategy_type}\n"
            f"Verified parameters:\n{params_txt}\n\n"
            f"User intent: {enriched_prompt}\n\n"
            f"{combined}"
            f"{self._chain_context(network, plan.strategy_type)}\n\nGenerate the 2 files now."
        )

        MAX_RETRIES = 2
        files: List[Dict[str, Any]] = []
        parsed: Dict[str, Any] = {}

        for attempt in range(MAX_RETRIES + 1):
            try:
                raw = self._llm(GENERATOR_SYSTEM, user_msg, temperature=0.1, max_tokens=self.max_tokens)
            except Exception as exc:
                if attempt < MAX_RETRIES:
                    time.sleep(LLM_RETRY_BASE_DELAY * (attempt + 1))
                    continue
                return {"status": "error", "message": f"LLM generation failed: {exc}"}

            parsed = self._parse_json(raw)
            files = self._assemble_files(parsed.get("files", []), plan.strategy_type)

            index_ts_content = next((f["content"] for f in files if f["filepath"] == "src/index.ts"), None)
            if not index_ts_content:
                break

            # Hallucination check
            hallucination_check = self._check_for_mcp_swap_hallucination(index_ts_content)
            if hallucination_check and attempt < MAX_RETRIES:
                user_msg = (
                    f"{user_msg}\n\n"
                    f"CRITICAL ERROR: {hallucination_check}\n"
                    "Use axios + @solana/web3.js for swaps. Return the FULL updated JSON."
                )
                continue

            with tempfile.TemporaryDirectory() as temp_dir:
                src_dir = os.path.join(temp_dir, "src")
                os.makedirs(src_dir, exist_ok=True)
                file_path = os.path.join(src_dir, "index.ts")
                with open(file_path, "w") as f:
                    f.write(index_ts_content)

                result = subprocess.run(
                    ["npx", "-y", "tsc", "--noEmit", "--target", "es2020", "--moduleResolution", "node", file_path],
                    capture_output=True, text=True, check=False
                )

                if result.returncode == 0:
                    return {"status": "ready", "files": files, "plan": plan.model_dump()}
                elif attempt < MAX_RETRIES:
                    error_msg = result.stdout + "\n" + result.stderr
                    user_msg = (
                        f"{user_msg}\n\nTypeScript errors:\n{error_msg[:1000]}\n\n"
                        "Fix the errors and return the FULL updated JSON."
                    )
                else:
                    return {"status": "ready", "files": files, "plan": plan.model_dump(), "warning": "TS errors"}

        return {"status": "ready", "files": files, "plan": plan.model_dump()}

    # ── Public API ─────────────────────────────────────────────────────────────

    def classify_intent(self, prompt: str, trace_id: Optional[str] = None) -> Dict[str, Any]:
        raw = self._llm(CLASSIFIER_SYSTEM, prompt, temperature=0.0, max_tokens=400,
                        operation="classify_intent", trace_id=trace_id)
        raw = re.sub(r"```(?:json)?\s*|\s*```", "", raw).strip()
        try:
            intent = json.loads(raw)
        except Exception:
            intent = {}

        intent["chain"]    = "solana"
        intent["network"]  = str(intent.get("network", "mainnet-beta"))
        intent["strategy"] = _normalize_strategy(str(intent.get("strategy", "")))
        intent["mcps"]     = ["solana"]
        intent.setdefault("bot_name", self._bot_name(intent["strategy"]))
        intent.setdefault("requires_openai", False)
        return intent

    async def build_bot(self, prompt: str, trace_id: Optional[str] = None) -> Dict[str, Any]:
        _log("INFO", f"build_bot prompt_chars={len(prompt)}", trace_id)

        if PLANNER_ENABLED:
            result = await self.orchestrate_bot_creation(
                [{"role": "user", "content": prompt}], trace_id=trace_id
            )
            if result.get("status") == "ready":
                return result
            _log("WARN", "Planner requested clarification in single-shot mode — falling back.", trace_id)

        intent    = self.classify_intent(prompt, trace_id=trace_id)
        network   = intent["network"]
        strategy  = intent["strategy"]
        chain_ctx = self._chain_context(network, strategy)

        user_msg = (
            f"Bot name: {intent['bot_name']}\n"
            f"Chain: solana | Network: {network}\n"
            f"Strategy: {strategy}\n"
            f"User intent: {prompt}\n\n"
            f"JUPITER DOCS CONTEXT (live MCP):\nunavailable for this request.\n\n"
            f"{chain_ctx}\n\nGenerate the 2 files now."
        )

        raw    = self._llm(GENERATOR_SYSTEM, user_msg, temperature=0.1, max_tokens=self.max_tokens)
        parsed = self._parse_json(raw)
        files  = self._assemble_files(parsed.get("files", []), strategy)

        return {
            "status": "ready",
            "intent": intent,
            "output": {"thoughts": parsed.get("thoughts", ""), "files": files},
        }

    async def build_bot_with_history(
        self,
        chat_history: List[Dict[str, str]],
        trace_id: Optional[str] = None,
    ) -> Dict[str, Any]:
        _log("INFO", f"build_bot_with_history turns={len(chat_history)}", trace_id)
        return await self.orchestrate_bot_creation(chat_history, trace_id=trace_id)

    # ── File assembly ──────────────────────────────────────────────────────────

    def _assemble_files(self, raw_files: Any, strategy: str) -> List[Dict[str, Any]]:
        normalized: List[Dict[str, Any]] = []
        for f in raw_files if isinstance(raw_files, list) else []:
            if not isinstance(f, dict):
                continue
            fp = _normalize_filepath(f.get("filepath"))
            if fp:
                normalized.append({**f, "filepath": fp})

        result: List[Dict[str, Any]] = []
        seen = set()
        for f in normalized:
            fp = str(f.get("filepath", ""))
            if fp == "src/mcp_bridge.ts":
                f = {**f, "content": MCP_BRIDGE_CONTENT}
            elif fp == "src/sns_resolver.ts":
                f = {**f, "content": SNS_RESOLVER_CONTENT}
            result.append(f)
            seen.add(fp)

        if "src/mcp_bridge.ts" not in seen:
            result.append({"filepath": "src/mcp_bridge.ts", "content": MCP_BRIDGE_CONTENT})
        if "src/sns_resolver.ts" not in seen:
            result.append({"filepath": "src/sns_resolver.ts", "content": SNS_RESOLVER_CONTENT})

        if "package.json" not in seen:
            result.append({
                "filepath": "package.json",
                "content": json.dumps({
                    "name": "agentia-solana-bot",
                    "version": "1.0.0",
                    "type": "module",
                    "scripts": {"start": "tsx src/index.ts"},
                    "dependencies": {
                        "axios": "^1.7.4",
                        "dotenv": "^16.4.0",
                        "@solana/web3.js": "^1.98.0",
                    },
                    "devDependencies": {
                        "typescript": "^5.4.0",
                        "@types/node": "^20.0.0",
                        "tsx": "^4.7.0",
                    },
                }, indent=2),
            })

        if "src/index.ts" not in seen:
            result.append({
                "filepath": "src/index.ts",
                "content": (
                    'import "dotenv/config";\n'
                    'import { getSolBalance } from "./mcp_bridge.js";\n\n'
                    'async function main(): Promise<void> {\n'
                    '  const network = String(process.env.SOLANA_NETWORK ?? "mainnet-beta");\n'
                    '  const wallet  = String(process.env.USER_WALLET_ADDRESS ?? "");\n'
                    '  const bal = await getSolBalance(network, wallet);\n'
                    '  console.log("SOL balance (lamports):", bal.toString());\n'
                    '}\n\nvoid main();\n'
                ),
            })

        wanted = {"package.json", "src/index.ts", "src/mcp_bridge.ts", "src/sns_resolver.ts"}
        return [f for f in result if str(f.get("filepath", "")) in wanted]

    # ── JSON parsing ───────────────────────────────────────────────────────────

    def _parse_json(self, raw: str) -> Dict[str, Any]:
        start = raw.find("{")
        end   = raw.rfind("}")
        if start != -1 and end != -1:
            raw = raw[start:end + 1]
        raw = re.sub(r",\s*([}\]])", r"\1", raw)
        try:
            from json_repair import loads as repair_loads  # type: ignore
            out = repair_loads(raw)
            if isinstance(out, str):
                out = json.loads(out)
            return out if isinstance(out, dict) else {}
        except Exception:
            pass
        try:
            return json.loads(raw)
        except Exception:
            return {"thoughts": "parse error", "files": [{"filepath": "error.ts", "content": raw}]}

    # ── Helpers ────────────────────────────────────────────────────────────────

    @staticmethod
    def _bot_name(strategy: str) -> str:
        return {
            "yield_sweeper":  "Solana Yield Sweeper",
            "arbitrage":      "Solana Spread Arbitrageur",
            "liquidation":    "Solana Liquidation Bot",
            "sniping":        "Solana Token Sniper",
            "dca":            "Solana DCA Bot",
            "grid":           "Solana Grid Trader",
            "whale_mirror":   "Solana Whale Mirror Bot",
            "sentiment":      "Solana Sentiment Bot",
            "custom_utility": "Custom Solana Bot",
        }.get(strategy, "Agentia Solana Bot")

    @staticmethod
    def _chain_context(network: str, strategy: str) -> str:
        return f"""
CHAIN CONTEXT — SOLANA ({network})

MCP TOOL REFERENCE (read-only data queries only):
  getSolBalance(network, walletAddress)           → bigint lamports
  getTokenBalance(network, walletAddress, mint)   → bigint token units
  callMcpTool("solana", "get_account_info", {{network, address}})
  callMcpTool("solana", "send_raw_transaction",  {{network, raw: "<base64>"}})
  callMcpTool("solana", "resolve_sns",           {{network, name: "alice.sol"}})

JUPITER SWAP EXECUTION (use axios, NOT callMcpTool):
  1. GET https://quote-api.jup.ag/v6/quote → quoteResponse
  2. POST https://quote-api.jup.ag/v6/swap → {{ swapTransaction: "<base64>" }}
  3. Sign locally: VersionedTransaction.deserialize(...); tx.sign([wallet]); connection.sendRawTransaction(...)

REQUIRED ENV VARS:
  SOLANA_NETWORK, SOLANA_RPC_URL, SOLANA_KEY,
  USER_WALLET_ADDRESS, TOKEN_MINT_ADDRESS,
  POLL_INTERVAL_MS, SIMULATION_MODE

RULES:
- Every BigInt value is in the token's smallest unit.
- SIMULATION_MODE=true by default — log swaps, do not execute them.
- @solana/web3.js handles all signing; MCP bridge handles only read queries.
- Never use execSync, child_process, or local CLI tools.
"""