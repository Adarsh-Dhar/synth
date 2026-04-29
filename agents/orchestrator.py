"""
orchestrator.py

Meta-Agent — Solana-native DeFi bot generator.

Pipeline:
  build_bot(prompt)
    └── orchestrate_bot_creation(chat_history)
          ├── PlannerAgent.plan(history)  → PlannerState
          ├── if needs_mcp_query  → call Solana MCP, inject result, continue
          ├── if missing params   → return {status: "clarification_needed"}
          └── if ready            → _generate_code_with_plan(enriched_prompt)
"""

import os
import re
import json
import time
import logging
from concurrent.futures import ThreadPoolExecutor, TimeoutError as FuturesTimeoutError
from pathlib import Path
from typing import Any, Dict, List, Optional
import tempfile
import subprocess

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

_BASE_DIR = Path(__file__).resolve().parent
load_dotenv(_BASE_DIR / ".env")
load_dotenv(_BASE_DIR / ".env.local", override=True)

logger = logging.getLogger(__name__)

LLM_TIMEOUT_SECONDS  = int(os.environ.get("META_AGENT_LLM_TIMEOUT_SECONDS", "240"))
LLM_MAX_RETRIES      = int(os.environ.get("META_AGENT_LLM_MAX_RETRIES", "2"))
LLM_RETRY_BASE_DELAY = float(os.environ.get("META_AGENT_LLM_RETRY_BASE_DELAY_SECONDS", "0.6"))
PLANNER_MAX_LOOPS    = int(os.environ.get("PLANNER_MAX_LOOPS", "4"))
PLANNER_ENABLED      = os.environ.get("PLANNER_ENABLED", "true").lower() != "false"
JUPITER_DOCS_MCP_URL = os.environ.get("JUPITER_DOCS_MCP_URL", "http://127.0.0.1:5001").rstrip("/")
JUPITER_DOCS_TIMEOUT_SECONDS = float(os.environ.get("JUPITER_DOCS_TIMEOUT_SECONDS", "8"))
JUPITER_DOCS_MAX_CHARS = int(os.environ.get("JUPITER_DOCS_MAX_CHARS", "4000"))
DODO_DOCS_MCP_URL = os.environ.get("DODO_DOCS_MCP_URL", "http://127.0.0.1:5002").rstrip("/")
DODO_DOCS_TIMEOUT_SECONDS = float(os.environ.get("DODO_DOCS_TIMEOUT_SECONDS", "6"))
DODO_DOCS_MAX_CHARS = int(os.environ.get("DODO_DOCS_MAX_CHARS", "4000"))
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

/** Get native SOL balance in lamports. */
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

/** Get SPL token balance in smallest units. */
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

/** GoldRush helper: fetch token balances with decoded metadata. */
export async function getGoldRushTokenBalances(
    network: string,
    walletAddress: string,
): Promise<unknown> {
    return callMcpTool("solana", "goldrush_token_balances", {
        network,
        wallet: walletAddress,
    });
}

/** MagicBlock helper for private token transfer path. */
export async function callMagicBlockPrivateTransfer(args: {
    network: string;
    from: string;
    to: string;
    mint: string;
    amount: string;
}): Promise<unknown> {
    return callMcpTool("solana", "magicblock_transfer", args);
}

/** Umbra helper for private shield operation. */
export async function callUmbraShield(args: {
    network: string;
    wallet: string;
    mint: string;
    amount: string;
}): Promise<unknown> {
    return callMcpTool("solana", "umbra_shield", args);
}

/** Umbra helper for anonymous transfer operation. */
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

# ─── SNS Resolver — injected into every generated bot ────────────────────────

SNS_RESOLVER_CONTENT = r'''
import { callMcpTool } from "./mcp_bridge.js";
import "dotenv/config";

const _cache = new Map<string, string>();

/** Returns true for Bonfida SNS handles like "alice.sol". */
export function isSolDomain(value: string): boolean {
  return /^[a-z0-9_-]+\.sol$/i.test(String(value ?? "").trim());
}

/** Returns the pubkey string if found, otherwise throws. */
export async function resolveAddress(nameOrAddress: string): Promise<string> {
  const v = String(nameOrAddress ?? "").trim();
  if (!isSolDomain(v)) return v;

  const key = v.toLowerCase();
  const cached = _cache.get(key);
  if (cached) return cached;

  const resp = await callMcpTool("solana", "resolve_sns", {
    network: String(process.env.SOLANA_NETWORK ?? "devnet"),
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
Return ONLY a valid JSON object — no markdown, no preamble.

Schema:
{
  "chain": "solana",
  "network": "devnet",
  "strategy": "arbitrage" | "yield_sweeper" | "liquidation" | "sniping" | "dca" | "grid" | "whale_mirror" | "sentiment" | "custom_utility" | "unknown",
  "mcps": ["solana"],
  "bot_name": "<human-readable name>",
  "requires_openai": false
}

Rules:
- chain is always "solana"
- network is always "devnet" (unless user says mainnet)
- yield / sweep / consolidate → "yield_sweeper"
- arb / spread / flash → "arbitrage"
- liquidation / health-factor → "liquidation"
- snipe / new-token / launch → "sniping"
- dca / dollar-cost → "dca"
- sentiment / social / news → "sentiment", requires_openai: true
- everything else → "custom_utility"
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

GENERATOR_SYSTEM = """\
You are an expert Solana bot engineer. Generate production-ready TypeScript for the Agentia platform.

Respond with RAW JSON only — no markdown fences, no preamble, no trailing text.

Schema:
{
  "thoughts": "<one paragraph: architecture rationale>",
  "files": [
    {"filepath": "package.json", "content": "..."},
    {"filepath": "src/index.ts",  "content": "..."}
  ]
}

Generate EXACTLY these 2 files in this order:
  1. package.json
  2. src/index.ts

The files src/mcp_bridge.ts and src/sns_resolver.ts are injected automatically — do NOT generate them.

Import from bridge: import { callMcpTool, getSolBalance, getTokenBalance } from './mcp_bridge.js';
Import from resolver (only if needed): import { resolveAddress, isSolDomain } from './sns_resolver.js';

CORE RULES:
1. TypeScript + Node.js (ESM). package.json must set "type": "module".
2. "start" script must be: "tsx src/index.ts"
3. Dependencies: axios ^1.7.4, dotenv ^16.4.0, tsx (dev), typescript (dev), @types/node (dev).
    Do NOT include @solana/web3.js — all chain access goes through MCP tools.
4. Import "dotenv/config" at the very top of src/index.ts.
5. All money arithmetic uses BigInt — never floats.
6. SIMULATION_MODE = process.env.SIMULATION_MODE !== "false" (default true).
7. TRADING: For Jupiter swaps, YOU MUST use the Jupiter Agent Skills via MCP.
    - Do NOT use raw axios to quote-api.jup.ag.
    - Do NOT build manual transactions.
    - Simply call the MCP tool: `await callMcpTool("jupiter", "execute_swap", { inputMint, outputMint, amount, userWallet })`
    - The MCP handles the routing, quoting, and transaction signing orchestration natively.
8. Use an inFlight boolean guard to prevent overlapping poll cycles.
9. Handle SIGINT / SIGTERM for graceful shutdown.
10. Never hardcode addresses — read everything from process.env.
11. DODO: If the user requests payment, metering, or profit-splitting flows, implement a Dodo webhook handler that verifies incoming webhook HMACs and exposes a `/dodo/webhook` route.
    In the secure sandbox, do not create an HTTP listener for the webhook. Instead, handle inbound webhook payloads via `process.on("message")` and keep the bot process ready to receive IPC messages from the worker launcher.

SOLANA MCP TOOL REFERENCE:
  Responsibility split:
     - Use MCP tools for balances, account reads, SNS resolution, generic RPC methods, AND transaction broadcasting (`send_raw_transaction`).
     - Use Axios HTTP calls for off-chain API data (like Jupiter routing).

  Read SOL balance:
    getSolBalance(network, walletAddress)  → bigint (lamports)

  Read SPL token balance:
    getTokenBalance(network, walletAddress, mint)  → bigint (smallest units)

  Generic RPC read (account info, slot, etc.):
    callMcpTool("solana", "get_account_info", { network, address })

  Send transaction (base64-encoded serialized tx):
    callMcpTool("solana", "send_raw_transaction", { network, raw: "<base64>" })

  Resolve SNS domain (.sol name) to pubkey:
    callMcpTool("solana", "resolve_sns", { network, name: "alice.sol" })

        === DYNAMIC MCP TOOL SCHEMAS ===
        You will be provided with context from the user's specific query below.
        You MUST strictly adhere to the TypeScript interfaces provided in that dynamic context.
        Do not hallucinate parameters.

ENV VARS your bot should read:
  SOLANA_NETWORK, SOLANA_RPC_URL, SOLANA_KEY,
  USER_WALLET_ADDRESS, TOKEN_MINT_ADDRESS,
  POOL_ADDRESS, PROGRAM_ID,
  TRADE_AMOUNT_LAMPORTS, MIN_PROFIT_LAMPORTS,
  POLL_INTERVAL_MS (default 15000), SIMULATION_MODE
"""

# ─── MetaAgent ────────────────────────────────────────────────────────────────

class MetaAgent:
    def __init__(self):
        # Use GITHUB_TOKEN (GitHub PAT) primarily, fall back to AZURE_AI_KEY.
        token = os.environ.get("GITHUB_TOKEN") or os.environ.get("AZURE_AI_KEY")
        if not token:
            raise ValueError("No AI model credential found. Set GITHUB_TOKEN or AZURE_AI_KEY in agents/.env")

        endpoint = os.environ.get("GITHUB_MODEL_ENDPOINT", "https://models.inference.ai.azure.com").rstrip("/")

        # Warn about a common misconfiguration: GitHub PAT against Azure endpoint.
        if isinstance(token, str) and token.startswith("github_pat_") and "azure" in endpoint:
            _log(
                "WARN",
                "GITHUB_TOKEN looks like a GitHub PAT but GITHUB_MODEL_ENDPOINT points to an Azure endpoint. "
                "This will cause 401/Bad credentials. Set GITHUB_MODEL_ENDPOINT to the GitHub models host or use AZURE_AI_KEY."
            )

        self.model_endpoint = endpoint
        self.model_token = token
        self.model = os.environ.get("GITHUB_MODEL_NAME", "gpt-4o")
        self.planner_model = os.environ.get("PLANNER_MODEL_NAME", "gpt-4o-mini")
        self.max_tokens = int(os.environ.get("GENERATION_MAX_TOKENS", "3000"))
        self.mcp_client = SolanaMCPClient()
        self.planner = PlannerAgent(llm_caller=self._llm)
        # Reuse an httpx client for LLM calls
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
        model_name = self.planner_model if operation == "planner" else self.model
        started_at = time.monotonic()

        def _retryable(exc: Exception) -> bool:
            t = str(exc).lower()
            return any(x in t for x in (
                "connection aborted", "remotedisconnected", "service response error",
                "connection reset", "temporarily unavailable", "timed out", "503", "502",
            ))

        def _complete():
            # Build request payload compatible with the inference endpoint
            url = self.model_endpoint
            if not url.endswith("/chat/completions"):
                url = url + "/chat/completions"

            payload = {
                "model": model_name,
                "messages": [
                    {"role": "system", "content": system},
                    {"role": "user", "content": user},
                ],
                "temperature": temperature,
                "max_tokens": max_tokens,
            }
            headers = {
                "Content-Type": "application/json",
                "Authorization": f"Bearer {self.model_token}",
            }
            resp = self._http_client.post(url, json=payload, headers=headers, timeout=LLM_TIMEOUT_SECONDS)
            resp.raise_for_status()
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
                if _retryable(exc) and attempt < max_attempts:
                    delay = round(LLM_RETRY_BASE_DELAY * attempt, 2)
                    _log("WARN", f"{operation}: retrying in {delay}s ({exc})", trace_id)
                    time.sleep(delay)
                    continue
                raise

        # Normalize response shape from different providers (Azure/GitHub/OpenAI-like)
        content = None
        if isinstance(response, dict):
            choices = response.get("choices") or []
            if isinstance(choices, list) and len(choices) > 0:
                first = choices[0]
                if isinstance(first, dict):
                    # Try common shapes: { message: { content: "..." } }
                    msg = first.get("message")
                    if isinstance(msg, dict) and isinstance(msg.get("content"), str):
                        content = msg.get("content")
                    # Fallback: choices[0].text
                    if content is None and isinstance(first.get("text"), str):
                        content = first.get("text")
        if content is None:
            content = str(response)
        elapsed = round(time.monotonic() - started_at, 2)
        _log("INFO", f"{operation}: done in {elapsed}s", trace_id)
        return content.strip() if isinstance(content, str) else str(content)

    # ── Planner orchestration loop ─────────────────────────────────────────────

    async def orchestrate_bot_creation_stream(
        self,
        user_msg: str,
        trace_id: Optional[str] = None,
    ):
        def emit(payload: Dict[str, Any]) -> str:
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

            _log(
                "INFO",
                f"Plan: strategy={plan.strategy_type} ready={plan.is_ready_for_code_generation} "
                f"mcp={plan.verification_step.needs_mcp_query if plan.verification_step else False} "
                f"missing={plan.missing_parameters}",
                trace_id,
            )

            vs = plan.verification_step
            if vs and vs.needs_mcp_query and vs.mcp_payload:
                purpose = vs.verification_purpose or "on-chain verification"
                try:
                    result = self.mcp_client.query(vs.mcp_payload)
                    summary = summarise_mcp_result(purpose, vs.mcp_payload, result)
                except Exception as exc:
                    summary = f"MCP Verification [{purpose}] FAILED: {exc}. Planner should proceed without this verification or ask user."
                history.append({"role": "system", "content": summary})
                continue

            if not plan.is_ready_for_code_generation:
                question = (
                    plan.clarifying_question_for_user
                    or "Could you provide more details about the tokens, pools, or addresses your bot should use?"
                )
                yield emit({"status": "clarification_needed", "question": question})
                return

            break

        if not plan:
            yield emit({"error": "Planner did not return a usable plan."})
            return

        network = plan.collected_parameters.get("SOLANA_NETWORK", "devnet")
        mcps = ["solana", "jupiter"]
        if plan.collected_parameters.get("GOLDRUSH_API_KEY"):
            mcps.append("goldrush")
        if plan.collected_parameters.get("MAGICBLOCK_PRIVATE_PAYMENTS_BASE_URL"):
            mcps.append("magicblock")
        if plan.collected_parameters.get("UMBRA_PROGRAM_ADDRESS"):
            mcps.append("umbra")
        intent = {
            "chain": "solana",
            "network": network,
            "strategy": plan.strategy_type,
            "mcps": mcps,
            "bot_name": self._bot_name(plan.strategy_type),
            "requires_openai": plan.strategy_type == "sentiment",
            "collected_parameters": plan.collected_parameters,
        }

        normalized_user_msg = user_msg.lower()
        needs_jupiter = plan.strategy_type in {"arbitrage", "sniping", "dca", "grid", "whale_mirror", "yield_sweeper"} or any(
            token in normalized_user_msg for token in ("jupiter", "swap", "quote", "trade", "arbitrage")
        )
        needs_dodo = plan.strategy_type in {"metered_execution", "private_transfer"} or any(
            token in normalized_user_msg for token in ("dodo", "payment", "meter", "billing", "invoice", "split", "checkout")
        )

        yield emit({"status": "fetching_context", "message": "Fetching live SDKs from MCP servers..."})

        async def fetch_all_contexts() -> tuple[str, str]:
            mcp = MultiMCPClient()
            try:
                await mcp.connect_default_sessions()
            except Exception:
                pass

            jup_res = ""
            dodo_res = ""

            if needs_jupiter:
                try:
                    jup_res = await mcp.call_tool("jupiter", "jupiter_docs", {"query": user_msg})
                except Exception as exc:
                    raise RuntimeError(f"Jupiter MCP unreachable: {exc}") from exc

            if needs_dodo:
                try:
                    dodo_res = await mcp.call_tool("dodo", "dodo_docs", {"query": user_msg})
                except Exception as exc:
                    raise RuntimeError(f"Dodo MCP unreachable: {exc}") from exc

            try:
                await mcp.shutdown()
            except Exception:
                pass

            return str(jup_res or ""), str(dodo_res or "")

        try:
            jupiter_docs, dodo_docs = await fetch_all_contexts()
        except Exception as exc:
            _log("ERROR", str(exc), trace_id)
            if "Jupiter" in str(exc):
                yield emit({"error": "Failed to load Jupiter Agent Skills. The MCP server is unreachable."})
            else:
                yield emit({"error": "Failed to load Dodo Payments Agent Skills. The MCP server is unreachable."})
            return

        enriched_prompt = f"{user_msg}\n\n"
        if jupiter_docs:
            enriched_prompt += f"=== JUPITER CONTEXT ===\n{jupiter_docs}\n\n"
        if dodo_docs:
            enriched_prompt += f"=== DODO CONTEXT ===\n{dodo_docs}\n\n"

        yield emit({"status": "generating_code", "message": "AI is writing TypeScript code..."})

        prompt_source = enriched_prompt
        final_files: List[Dict[str, Any]] = []
        final_warning: Optional[str] = None
        MAX_RETRIES = 2

        for attempt in range(MAX_RETRIES + 1):
            raw = self._llm(GENERATOR_SYSTEM, prompt_source, temperature=0.1, max_tokens=self.max_tokens)
            parsed = self._parse_json(raw)
            final_files = self._assemble_files(parsed.get("files", []), plan.strategy_type)

            index_ts_content = next((f.get("content") for f in final_files if f.get("filepath") == "src/index.ts"), None)
            if not index_ts_content:
                break

            yield emit({"status": "validating_syntax", "message": "Running local TypeScript compiler..."})

            with tempfile.TemporaryDirectory() as temp_dir:
                src_dir = os.path.join(temp_dir, "src")
                os.makedirs(src_dir, exist_ok=True)
                file_path = os.path.join(src_dir, "index.ts")

                with open(file_path, "w") as handle:
                    handle.write(str(index_ts_content))

                result = subprocess.run(
                    ["npx", "-y", "tsc", "--noEmit", "--target", "es2020", "--moduleResolution", "node", file_path],
                    capture_output=True,
                    text=True,
                    check=False,
                )

                if result.returncode == 0:
                    yield emit({"status": "complete", "files": final_files, "plan": plan.to_dict(), "intent": intent})
                    return

                error_msg = (result.stdout + "\n" + result.stderr).strip()
                if attempt < MAX_RETRIES:
                    yield emit({"status": "self_healing", "message": "Syntax error caught. AI is self-healing..."})
                    prompt_source = (
                        f"{enriched_prompt}\n\n"
                        f"The code you generated failed TypeScript validation with this error:\n\n"
                        f"{error_msg[:1000]}\n\n"
                        "Fix the TypeScript errors and return the FULL updated JSON again."
                    )
                else:
                    final_warning = "Code generated with TypeScript errors."
                    break

        yield emit({"status": "complete", "files": final_files, "plan": plan.to_dict(), "intent": intent, "warning": final_warning})

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

    # ── Code generation ────────────────────────────────────────────────────────

    async def _generate_code_with_plan(
        self,
        plan: PlannerState,
        enriched_prompt: str,
        trace_id: Optional[str] = None,
    ) -> Dict[str, Any]:
        network = plan.collected_parameters.get("SOLANA_NETWORK", "devnet")
        mcps = ["solana", "jupiter"]
        if plan.collected_parameters.get("GOLDRUSH_API_KEY"):
            mcps.append("goldrush")
        if plan.collected_parameters.get("MAGICBLOCK_PRIVATE_PAYMENTS_BASE_URL"):
            mcps.append("magicblock")
        if plan.collected_parameters.get("UMBRA_PROGRAM_ADDRESS"):
            mcps.append("umbra")
        intent = {
            "chain":    "solana",
            "network":  network,
            "strategy": plan.strategy_type,
            "mcps":     mcps,
            "bot_name": self._bot_name(plan.strategy_type),
            "requires_openai": plan.strategy_type == "sentiment",
            "collected_parameters": plan.collected_parameters,
        }

        chain_ctx = self._chain_context(network, plan.strategy_type)

        # 1. Fetch RAG context explicitly using correct MCP tool names.
        async def fetch_all_contexts() -> tuple[str, str]:
            mcp = MultiMCPClient()
            try:
                await mcp.connect_default_sessions()
            except Exception:
                pass

            try:
                jup_res = await mcp.call_tool("jupiter", "jupiter_docs", {"query": enriched_prompt})
            except Exception as exc:
                _log("WARN", f"Jupiter MCP jupiter_docs failed: {exc}", trace_id)
                jup_res = ""

            try:
                dodo_res = await mcp.call_tool("dodo", "dodo_docs", {"query": enriched_prompt})
            except Exception as exc:
                _log("WARN", f"Dodo MCP dodo_docs failed: {exc}", trace_id)
                dodo_res = ""

            try:
                await mcp.shutdown()
            except Exception:
                pass

            return jup_res or "", dodo_res or ""

        # 2. Execute natively (no asyncio.new_event_loop() hack).
        try:
            jupiter_docs, dodo_docs = await fetch_all_contexts()
        except Exception as e:
            _log("WARN", f"Context fetch failed: {e}", trace_id)
            jupiter_docs, dodo_docs = "", ""
        # ---------------------------------------

        combined = ""
        parts = []
        if jupiter_docs:
            parts.append(("JUPITER DOCS CONTEXT (live MCP):\n", jupiter_docs, JUPITER_DOCS_MAX_CHARS))
        if dodo_docs:
            parts.append(("DODO DOCS CONTEXT (live MCP):\n", dodo_docs, DODO_DOCS_MAX_CHARS))

        remaining = CONTEXT_INJECTION_MAX_CHARS
        for header, text, limit in parts:
            take = min(limit, len(text), remaining)
            if take <= 0:
                continue
            combined += f"{header}{text[:take]}\n\n"
            remaining -= take

        if not combined:
            combined = "JUPITER + DODO DOCS CONTEXT: unavailable for this request.\n\n"
        params_txt = "\n".join(f"  {k}={v}" for k, v in plan.collected_parameters.items())
        user_msg = (
            f"Bot name: {intent['bot_name']}\n"
            f"Chain: solana | Network: {network}\n"
            f"Strategy: {plan.strategy_type}\n"
            f"Verified parameters:\n{params_txt}\n\n"
            f"User intent: {enriched_prompt}\n\n"
            f"{combined}"
            f"{chain_ctx}\n\nGenerate the 2 files now."
        )

        _log("INFO", f"Generator prompt chars={len(user_msg)}", trace_id)
        # Setup conversation history for potential self-healing
        messages = [
            {"role": "system", "content": GENERATOR_SYSTEM},
            {"role": "user", "content": user_msg}
        ]
        
        MAX_RETRIES = 2
        
        for attempt in range(MAX_RETRIES + 1):
            # 1. Generate the Code
            raw = self._llm(GENERATOR_SYSTEM, user_msg, temperature=0.1, max_tokens=self.max_tokens)
            parsed = self._parse_json(raw)
            files = self._assemble_files(parsed.get("files", []), plan.strategy_type)
            
            # 2. Extract src/index.ts for validation
            index_ts_content = next((f["content"] for f in files if f["filepath"] == "src/index.ts"), None)
            
            if not index_ts_content:
                break  # If the LLM failed to output index.ts, break and return what we have
                
            # 3. Perform Pre-Flight Syntax Check
            with tempfile.TemporaryDirectory() as temp_dir:
                src_dir = os.path.join(temp_dir, "src")
                os.makedirs(src_dir, exist_ok=True)
                file_path = os.path.join(src_dir, "index.ts")
                
                with open(file_path, "w") as f:
                    f.write(index_ts_content)
                
                try:
                    # Run a dry-run TypeScript check using npx
                    result = subprocess.run(
                        ["npx", "-y", "tsc", "--noEmit", "--target", "es2020", "--moduleResolution", "node", file_path],
                        capture_output=True,
                        text=True,
                        check=False
                    )
                    
                    if result.returncode == 0:
                        # Success! Code compiles cleanly.
                        _log("INFO", f"Syntax check passed on attempt {attempt + 1}", trace_id)
                        return {
                            "status": "ready",
                            "files": files,
                            "plan": plan.to_dict()
                        }
                    else:
                        # Failure! Capture the TS Compiler Error
                        error_msg = result.stdout + "\n" + result.stderr
                        _log("WARN", f"Syntax error on attempt {attempt + 1}: {error_msg[:200]}...", trace_id)
                        
                        if attempt < MAX_RETRIES:
                            # Append the error back to the LLM to self-heal
                            messages.append({"role": "assistant", "content": raw})
                            messages.append({
                                "role": "user", 
                                "content": f"The code you generated failed TypeScript validation with this error:\n\n{error_msg[:1000]}\n\nFix the TypeScript errors and return the FULL updated JSON again."
                            })
                        else:
                            # Out of retries, return the files but flag the error
                            _log("ERROR", "Max self-healing retries exhausted.", trace_id)
                            return {
                                "status": "ready",
                                "files": files,
                                "plan": plan.to_dict(),
                                "warning": "Code generated with TypeScript errors."
                            }
                except Exception as e:
                    _log("WARN", f"Skipping syntax check due to environment error: {e}", trace_id)
                    break  # Fallback to returning files if npx/tsc isn't installed locally
        
        # Fallback return
        return {
            "status": "ready",
            "files": files,
            "plan": plan.to_dict()
        }

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
        intent["network"]  = str(intent.get("network", "devnet"))
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

        # Legacy direct generation
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
        # Normalize paths
        normalized: List[Dict[str, Any]] = []
        for f in raw_files if isinstance(raw_files, list) else []:
            if not isinstance(f, dict):
                continue
            fp = _normalize_filepath(f.get("filepath"))
            if fp:
                normalized.append({**f, "filepath": fp})

        # Always overwrite bridge files with canonical versions
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

        # Fallback package.json
        if "package.json" not in seen:
            result.append({
                "filepath": "package.json",
                "content": json.dumps({
                    "name": "agentia-solana-bot",
                    "version": "1.0.0",
                    "type": "module",
                    "scripts": {"start": "tsx src/index.ts"},
                    "dependencies": {"axios": "^1.7.4", "dotenv": "^16.4.0"},
                    "devDependencies": {
                        "typescript": "^5.4.0",
                        "@types/node": "^20.0.0",
                        "tsx": "^4.7.0",
                    },
                }, indent=2),
            })

        # Fallback src/index.ts
        if "src/index.ts" not in seen:
            result.append({
                "filepath": "src/index.ts",
                "content": (
                    'import "dotenv/config";\n'
                    'import { getSolBalance } from "./mcp_bridge.js";\n\n'
                    'async function main(): Promise<void> {\n'
                    '  const network = String(process.env.SOLANA_NETWORK ?? "devnet");\n'
                    '  const wallet  = String(process.env.USER_WALLET_ADDRESS ?? "");\n'
                    '  const bal = await getSolBalance(network, wallet);\n'
                    '  console.log("SOL balance (lamports):", bal.toString());\n'
                    '}\n\nvoid main();\n'
                ),
            })

        # Return only the four canonical files
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
        sl = strategy.lower()
        bridge_note = ""
        if "sweep" in sl or "cross" in sl:
            bridge_note = (
                "\nBridge: use Wormhole or Portal bridge program IDs for cross-chain transfers.\n"
                "For token transfers use SPL token transfer instructions.\n"
            )
        return f"""
CHAIN CONTEXT — SOLANA ({network})

MCP TOOL REFERENCE (all chain I/O must go through these):
  getSolBalance(network, walletAddress)           → bigint lamports
  getTokenBalance(network, walletAddress, mint)   → bigint token units
  callMcpTool("solana", "get_account_info", {{network, address}})
  callMcpTool("solana", "send_raw_transaction",  {{network, raw: "<base64>"}})
  callMcpTool("solana", "resolve_sns",           {{network, name: "alice.sol"}})
{bridge_note}
REQUIRED ENV VARS:
  SOLANA_NETWORK, SOLANA_RPC_URL, SOLANA_KEY,
  USER_WALLET_ADDRESS, TOKEN_MINT_ADDRESS,
  POOL_ADDRESS, PROGRAM_ID,
  TRADE_AMOUNT_LAMPORTS, MIN_PROFIT_LAMPORTS,
    POLL_INTERVAL_MS, SIMULATION_MODE,
    GOLDRUSH_API_KEY, GOLDRUSH_STREAM_URL,
    MAGICBLOCK_TEE_VALIDATOR, MAGICBLOCK_PRIVATE_PAYMENTS_BASE_URL,
    UMBRA_PROGRAM_ADDRESS, UMBRA_NETWORK,
    DODO_PLAN_PRO_ID

RULES:
- Every BigInt value is in the token's smallest unit (lamports for SOL).
- SIMULATION_MODE=true by default — log what would happen, don't send.
- Do NOT import @solana/web3.js — the MCP bridge handles all RPC calls.
"""