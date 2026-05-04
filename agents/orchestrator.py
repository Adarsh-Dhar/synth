"""
orchestrator.py  (v6 — Native Code Generation Edition)

Meta-Agent — Solana-native DeFi bot generator.

KEY CHANGE from v5:
  - Removed MCP_BRIDGE_CONTENT / SNS_RESOLVER_CONTENT hardcoded injections.
  - The Meta-Agent now generates 100% standalone TypeScript that uses
    @solana/web3.js and @bonfida/spl-name-service natively.
  - Generated bots are portable — no backend dependency at runtime.
  - The MCP servers (solana-mcp-server, jupiter-mcp-server) are used ONLY
    during the planning phase to fetch live context (quotes, docs, balances).
    They are NOT injected as runtime dependencies into the generated code.

Pipeline:
  build_bot_copilot(prompt, session_id)
    └── CopilotPlannerAgent.start_session(prompt)   ← ReAct loop
          ├── think  → plan what we need
          ├── ask_user  → pause & wait for clarification
          ├── query_onchain → verify wallet/mint via MCP (planning only)
          ├── emit_plan → show architecture to user
          └── finish → hand enriched prompt to code generator

  continue_copilot(state, user_reply)
    └── CopilotPlannerAgent.continue_session(state, reply)

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
    CopilotPlannerAgent,
    CopilotState,
    PlannerAgent,
    PlannerState,
    SolanaMCPClient,
    build_yield_sweeper_enriched_prompt,
    extract_resolved_address,
    summarise_mcp_result,
)
try:
    from jupiter_prompt import (
        JUPITER_SYSTEM_CONTEXT,
        JUPITER_API_KEY as _JUP_API_KEY,
        build_jupiter_user_context as _build_jup_ctx,
        get_mcp_tool_descriptions as _jup_mcp_tools,
        write_docs_json as _write_jup_docs,
    )
    _JUPITER_AVAILABLE = True
except ImportError:
    JUPITER_SYSTEM_CONTEXT = ""
    _JUPITER_AVAILABLE = False

    async def _build_jup_ctx(strategy: str = "custom_utility", tokens: Optional[List[str]] = None) -> str:
        return ""

    def _jup_mcp_tools() -> str:
        return ""

    def _write_jup_docs() -> None:
        return None

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
        "tsconfig.json": "tsconfig.json",
        "index.ts": "src/index.ts",
        "main.ts": "src/index.ts",
    }
    return aliases.get(lower) or aliases.get(base) or p


# ─── Generator System Prompt ──────────────────────────────────────────────────
# The LLM is now taught to write ALL logic natively — no bridge files, no
# backend dependency. Every pattern it needs is provided as boilerplate
# directly in this prompt.

GENERATOR_SYSTEM = """\
You are an expert Solana bot engineer. Generate production-ready, 100% standalone TypeScript.

CRITICAL PHILOSOPHY: The generated bot must run on ANY computer without any backend server.
It uses only npm packages. No external bridge files, no local MCP gateway at runtime.

Respond with valid JSON only (no markdown):

{
  "thoughts": "<one paragraph: architecture rationale>",
  "files": [
    {"filepath": "package.json",    "content": "..."},
    {"filepath": "tsconfig.json",   "content": "..."},
    {"filepath": "src/index.ts",    "content": "..."}
  ]
}

Generate exactly these 3 files in this order:
  1. package.json
  2. tsconfig.json
  3. src/index.ts

════════════════════════════════════════════════════════════
NATIVE SOLANA PATTERNS — USE THESE EXACT IMPLEMENTATIONS
════════════════════════════════════════════════════════════

1. CONNECTION & WALLET SETUP (always at top of src/index.ts):
   import { config } from "dotenv";
   import { fileURLToPath } from "url";
   import { dirname, join } from "path";
   import { Connection, Keypair, PublicKey, LAMPORTS_PER_SOL, VersionedTransaction } from "@solana/web3.js";
   import axios from "axios";

   const __filename = fileURLToPath(import.meta.url);
   const botDir = dirname(dirname(__filename));
   config({ path: join(botDir, ".env") });

   const NETWORK    = process.env.SOLANA_NETWORK ?? "mainnet-beta";
   const RPC_URL    = process.env.SOLANA_RPC_URL ?? "https://api.mainnet-beta.solana.com";
   const WALLET_ADDR = process.env.USER_WALLET_ADDRESS ?? "";
   const SIM_MODE   = process.env.SIMULATION_MODE !== "false"; // default true

   const connection = new Connection(RPC_URL, { commitment: "confirmed" });
   const wallet     = Keypair.fromSecretKey(
     new Uint8Array(JSON.parse(process.env.SOLANA_KEY ?? "[]"))
   );

   console.log("=== Bot Config ===");
   console.log("Network:", NETWORK, "| RPC:", RPC_URL);
   console.log("Wallet:", wallet.publicKey.toBase58());
   console.log("Simulation mode:", SIM_MODE);

2. NATIVE SOL BALANCE (never use a bridge or external HTTP for this):
   async function getSolBalance(address: string): Promise<bigint> {
     const lamports = await connection.getBalance(new PublicKey(address));
     return BigInt(lamports);
   }

3. NATIVE SPL TOKEN BALANCE (use getParsedTokenAccountsByOwner):
   async function getTokenBalance(walletAddress: string, mintAddress: string): Promise<bigint> {
     const accounts = await connection.getParsedTokenAccountsByOwner(
       new PublicKey(walletAddress),
       { mint: new PublicKey(mintAddress) }
     );
     if (accounts.value.length === 0) return 0n;
     const amount = accounts.value[0].account.data.parsed.info.tokenAmount.amount;
     return BigInt(amount);
   }

4. NATIVE SNS DOMAIN RESOLUTION (install @bonfida/spl-name-service):
   import { getDomainKey, NameRegistryState } from "@bonfida/spl-name-service";
   const _snsCache = new Map<string, string>();
   async function resolveAddress(nameOrAddress: string): Promise<string> {
     if (!nameOrAddress.endsWith(".sol")) return nameOrAddress;
     if (_snsCache.has(nameOrAddress)) return _snsCache.get(nameOrAddress)!;
     const { pubkey } = await getDomainKey(nameOrAddress);
     const { registry } = await NameRegistryState.retrieve(connection, pubkey);
     const resolved = registry.owner.toBase58();
     _snsCache.set(nameOrAddress, resolved);
     return resolved;
   }

5. JUPITER SWAP EXECUTION (native HTTP, no bridge):
   async function executeJupiterSwap(
     inputMint: string, outputMint: string,
     amount: bigint, userWallet: string
   ): Promise<string | null> {
     if (SIM_MODE) {
       console.log(`[SIM] Would swap ${amount} ${inputMint} → ${outputMint}`);
       return null;
     }
     const quoteResp = await axios.get("https://quote-api.jup.ag/v6/quote", {
       params: { inputMint, outputMint, amount: amount.toString(), slippageBps: 50 },
       timeout: 10_000,
     });
     const swapResp = await axios.post("https://quote-api.jup.ag/v6/swap", {
       quoteResponse: quoteResp.data,
       userPublicKey: userWallet,
       wrapAndUnwrapSol: true,
       dynamicComputeUnitLimit: true,
       prioritizationFeeLamports: { autoMultiplier: 2 },
     }, { timeout: 10_000 });
     const tx = VersionedTransaction.deserialize(
       Buffer.from(swapResp.data.swapTransaction, "base64")
     );
     tx.sign([wallet]);
     const txid = await connection.sendRawTransaction(
       tx.serialize(), { skipPreflight: true, maxRetries: 2 }
     );
     console.log("Swap executed:", txid);
     return txid;
   }

6. RETRY HELPER (always include):
   async function sleep(ms: number): Promise<void> {
     return new Promise(r => setTimeout(r, ms));
   }
   async function withRetry<T>(fn: () => Promise<T>, attempts = 3, baseDelayMs = 500): Promise<T> {
     let lastErr: Error = new Error("unknown");
     for (let i = 0; i < attempts; i++) {
       try { return await fn(); }
       catch (e) {
         lastErr = e as Error;
         if (i < attempts - 1) await sleep(baseDelayMs * Math.pow(2, i));
       }
     }
     throw lastErr;
   }

7. GRACEFUL SHUTDOWN (always include):
   let intervalId: ReturnType<typeof setInterval> | null = null;
   function shutdown(signal: string) {
     console.log(`[${signal}] Shutting down…`);
     if (intervalId) clearInterval(intervalId);
     process.exit(0);
   }
   process.on("SIGINT",  () => shutdown("SIGINT"));
   process.on("SIGTERM", () => shutdown("SIGTERM"));

════════════════════════════════════════════════════════════
PACKAGE.JSON TEMPLATE (always use this structure)
════════════════════════════════════════════════════════════
{
  "name": "<bot-name-kebab>",
  "version": "1.0.0",
  "type": "module",
  "scripts": { "start": "tsx src/index.ts", "build": "tsc" },
  "dependencies": {
    "axios": "^1.7.4",
    "dotenv": "^16.4.0",
    "@solana/web3.js": "^1.98.0",
    "@bonfida/spl-name-service": "^3.0.0"
  },
  "devDependencies": {
    "typescript": "^5.4.0",
    "@types/node": "^20.0.0",
    "tsx": "^4.7.0"
  }
}

TSCONFIG.JSON TEMPLATE:
{
  "compilerOptions": {
    "target": "ES2020", "module": "ES2020",
    "moduleResolution": "node", "outDir": "dist",
    "rootDir": "src", "strict": true,
    "esModuleInterop": true, "skipLibCheck": true
  },
  "include": ["src/**/*"]
}

════════════════════════════════════════════════════════════
ABSOLUTE RULES (never break these)
════════════════════════════════════════════════════════════
1. NEVER import from "./mcp_bridge.js" or "./sns_resolver.js" — these files do NOT exist.
2. NEVER call callMcpTool() — this function does NOT exist at runtime.
3. NEVER use execSync, child_process, or any local CLI tool.
4. NEVER call callMcpTool("jupiter", "execute_swap", ...) — does not exist, will crash.
5. All token amounts internally are BigInt (smallest unit). Convert only for display.
6. SIMULATION_MODE=true by default. When true, log what would happen instead of executing.
7. Use inFlight boolean guard to prevent overlapping poll cycles.
8. Handle SIGINT/SIGTERM for graceful shutdown (clearInterval + process.exit).
9. Load .env using explicit path resolution (fileURLToPath pattern shown above).
10. Log all env vars at startup for debugging.
11. MINT ROUTING: never set inputMint === outputMint.
12. For finite strategies (N chunks), use a for-loop + process.exit(0). NOT while(true).
13. For daemon strategies (continuous monitoring), use setInterval.
14. When APY APIs return Cloudflare 403/404, implement graceful fallback with cached last value.
15. SWAP PAYLOAD must always include dynamicComputeUnitLimit:true and prioritizationFeeLamports.

ENV VARS your bot should read:
  SOLANA_NETWORK, SOLANA_RPC_URL, SOLANA_KEY,
  USER_WALLET_ADDRESS, TOKEN_MINT_ADDRESS,
  POOL_ADDRESS, PROGRAM_ID,
  TRADE_AMOUNT_LAMPORTS, MIN_PROFIT_LAMPORTS,
  POLL_INTERVAL_MS (default 15000), SIMULATION_MODE
"""

if _JUPITER_AVAILABLE:
        GENERATOR_SYSTEM = GENERATOR_SYSTEM + JUPITER_SYSTEM_CONTEXT

DEMO_CONTEXT = """
=== YIELD SWEEPER CONTEXT (Kamino ↔ sUSDe) ===

EXACT MINT ADDRESSES (hardcoded, never ask):
    USDC:   EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v  (6 decimals)
    sUSDe:  G9W2WBKV3nJULX4kz47HCJ75jnVG4RYWZj5q5U5kXfz   (18 decimals)
    SOL:    So11111111111111111111111111111111111111112      (9 decimals)

APY FETCH PATTERN (with graceful fallback for Cloudflare blocks):
    let _lastKaminoApy = 12.0;
    let _lastSusdeApy  = 5.0;

    async function fetchKaminoApy(): Promise<number> {
      try {
        const r = await axios.get(process.env.KAMINO_APY_URL ?? "", {
          timeout: 8000,
          headers: { "User-Agent": "Mozilla/5.0 (compatible; SolanaBot/1.0)" },
        });
        const val = extractFirstNumber(r.data, ["supplyApy","supplyAPY","apr","apy"]);
        if (val !== null) { _lastKaminoApy = val; return val; }
      } catch (e) {
        console.warn("[WARN] Kamino APY fetch failed, using cached:", _lastKaminoApy);
      }
      return _lastKaminoApy;
    }

    async function fetchSusdeApy(): Promise<number> {
      try {
        const r = await axios.get(process.env.SUSDE_APY_URL ?? "", { timeout: 8000 });
        const val = Number(r.data?.apy ?? r.data?.yield ?? 0);
        if (val > 0) { _lastSusdeApy = val; return val; }
      } catch (e) {
        console.warn("[WARN] sUSDe APY fetch failed, using cached:", _lastSusdeApy);
      }
      return _lastSusdeApy;
    }

    function extractFirstNumber(data: unknown, keys: string[]): number | null {
      if (Array.isArray(data) && data.length > 0) data = data[0];
      if (typeof data !== "object" || data === null) return null;
      for (const k of keys) {
        const v = Number((data as Record<string,unknown>)[k]);
        if (!isNaN(v) && v > 0) return v;
      }
      return null;
    }

DECIMAL HELPERS:
    const toUiUsdc  = (raw: bigint) => Number(raw) / 1e6;
    const toUiSusde = (raw: bigint) => Number(raw) / 1e18;

REBALANCE LOGIC:
    const THRESHOLD = parseFloat(process.env.REBALANCE_THRESHOLD_PCT ?? "1.5");
    // Enter sUSDe when: susdeApy - kaminoApy >= THRESHOLD
    // Enter Kamino when: kaminoApy - susdeApy >= THRESHOLD
"""


# ─── MetaAgent ────────────────────────────────────────────────────────────────

class MetaAgent:
    def __init__(self):
        token = os.environ.get("GITHUB_TOKEN") or os.environ.get("AZURE_AI_KEY")
        if not token:
            raise ValueError("No AI model credential found. Set GITHUB_TOKEN or AZURE_AI_KEY in agents/.env")

        endpoint = os.environ.get("GITHUB_MODEL_ENDPOINT", "https://models.inference.ai.azure.com").rstrip("/")

        self.model_endpoint = endpoint
        self.model_token = token
        self.model = os.environ.get("GITHUB_MODEL_NAME", "gpt-4o")
        self.planner_model = os.environ.get("PLANNER_MODEL_NAME", "gpt-4o-mini")
        self.max_tokens = int(os.environ.get("GENERATION_MAX_TOKENS", "3500"))
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

    # ── Copilot API ────────────────────────────────────────────────────────────

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

        # Fetch live context from MCP servers (planning phase only)
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
            user_msg += f"=== JUPITER CONTEXT ===\n{jupiter_docs[:CONTEXT_INJECTION_MAX_CHARS]}\n\n"

        if strategy in ("yield_sweeper", "shielded_yield"):
            user_msg += DEMO_CONTEXT + "\n\n"

        user_msg += (
            "ENV NOTE: Bot must read JUPITER_API_KEY from process.env and use "
            "x-api-key header on all Jupiter API calls.\n\n"
            f"{chain_ctx}\n\n"
            "Generate exactly 3 files: package.json, tsconfig.json, src/index.ts."
        )

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

            # Validate: no bridge imports survived
            violation = self._check_for_bridge_violations(index_ts)
            if violation:
                _log("WARN", f"Bridge violation on attempt {attempt+1}: {violation}", trace_id)
                if attempt < MAX_RETRIES:
                    user_msg = (
                        f"{user_msg}\n\n"
                        f"CRITICAL ERROR in your previous output: {violation}\n"
                        "You MUST use native @solana/web3.js patterns. "
                        "Do NOT import from mcp_bridge.js or sns_resolver.js. "
                        "Fix and return the complete updated JSON."
                    )
                    continue

            # TypeScript syntax check
            ts_error = self._typecheck(index_ts)
            if ts_error and attempt < MAX_RETRIES:
                user_msg = (
                    f"{user_msg}\n\n"
                    f"TypeScript errors:\n\n{ts_error[:800]}\n\n"
                    "Fix ALL errors and return the FULL updated JSON."
                )
            else:
                break

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
        """Fetch Jupiter context: first try jupiter_prompt module (static + structured),
        then attempt live MCP server for extra docs. Combines both into a single string."""
        jup_static = await _build_jup_ctx(strategy=strategy)

        normalized = prompt.lower()
        needs_jupiter = strategy in {
            "arbitrage", "sniping", "dca", "grid", "whale_mirror",
            "yield_sweeper", "prediction_arb", "perps", "flash_arb",
            "trigger_bot", "adaptive_dca", "sentiment",
        } or any(t in normalized for t in (
            "jupiter", "swap", "quote", "trade", "limit", "perp",
            "lend", "predict", "recurring",
        ))

        jup_mcp = ""
        if needs_jupiter:
            mcp = MultiMCPClient()
            try:
                await mcp.connect_default_sessions()
                try:
                    jup_mcp = await mcp.call_tool("jupiter", "search_docs", {"query": prompt})
                except Exception as exc:
                    _log("WARN", f"Jupiter MCP docs fetch failed (non-fatal): {exc}")
            except Exception:
                pass
            try:
                await mcp.shutdown()
            except Exception:
                pass

        parts: List[str] = []
        if jup_static:
            parts.append(jup_static)
        if jup_mcp:
            parts.append(f"=== JUPITER MCP DOCS ===\n{str(jup_mcp)}")

        return "\n\n".join(parts)

    # ── Validation helpers ─────────────────────────────────────────────────────

    @staticmethod
    def _check_for_bridge_violations(code: str) -> Optional[str]:
        """Detect forbidden patterns: bridge imports and hallucinated MCP swap calls."""
        # Importing from bridge files
        if re.search(r'from\s+["\']\.\/mcp_bridge(?:\.js)?["\']', code):
            return "Imports from './mcp_bridge.js' detected — this file does not exist. Use native @solana/web3.js."
        if re.search(r'from\s+["\']\.\/sns_resolver(?:\.js)?["\']', code):
            return "Imports from './sns_resolver.js' detected — this file does not exist. Use @bonfida/spl-name-service natively."
        # Hallucinated MCP swap tools
        if re.search(r'callMcpTool\s*\(\s*["\']jupiter["\'].*["\']execute_swap["\']', code, re.DOTALL):
            return "callMcpTool('jupiter','execute_swap') does not exist. Use axios to call quote-api.jup.ag/v6 directly."
        if re.search(r'callMcpTool\s*\(\s*["\']jupiter["\'].*["\']swap["\']', code, re.DOTALL):
            return "callMcpTool('jupiter','swap') does not exist. Use the Jupiter V6 HTTP API directly."
        # Using callMcpTool at all (it no longer exists in standalone bots)
        if re.search(r'\bcallMcpTool\b', code):
            return "callMcpTool() is not available in standalone bots. Use native @solana/web3.js methods."
        return None

    @staticmethod
    def _typecheck(code: str) -> Optional[str]:
        """Run tsc --noEmit on the generated index.ts. Returns error string or None."""
        try:
            with tempfile.TemporaryDirectory() as tmp:
                src_dir = os.path.join(tmp, "src")
                os.makedirs(src_dir)
                fp = os.path.join(src_dir, "index.ts")
                with open(fp, "w") as f:
                    f.write(code)
                result = subprocess.run(
                    ["npx", "-y", "tsc", "--noEmit", "--target", "es2020",
                     "--moduleResolution", "node", "--skipLibCheck", fp],
                    capture_output=True, text=True, check=False,
                )
                if result.returncode != 0:
                    return (result.stdout + "\n" + result.stderr).strip()
        except Exception as exc:
            _log("WARN", f"TypeScript check failed to run: {exc}")
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

        yield emit({"status": "fetching_context", "message": "Fetching live Jupiter docs from MCP..."})
        jupiter_docs = await self._fetch_rag_context(user_msg, plan.strategy_type)

        enriched_prompt = f"{user_msg}\n\n"
        if jupiter_docs:
            enriched_prompt += f"=== JUPITER CONTEXT (reference only) ===\n{jupiter_docs}\n\n"

        yield emit({"status": "generating_code", "message": "AI is writing native TypeScript code..."})

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

            violation = self._check_for_bridge_violations(index_ts_content)
            if violation and attempt < MAX_RETRIES:
                _log("WARN", f"Bridge violation attempt {attempt+1}: {violation}", trace_id)
                yield emit({"status": "self_healing", "message": "Removing deprecated bridge dependencies..."})
                prompt_source = (
                    f"{enriched_prompt}\n\n"
                    f"CRITICAL ERROR: {violation}\n"
                    "Use native @solana/web3.js. Return the FULL updated JSON."
                )
                continue

            yield emit({"status": "validating_syntax", "message": "Running TypeScript compiler..."})
            ts_error = self._typecheck(index_ts_content)

            if ts_error is None:
                yield emit({"status": "complete", "files": final_files, "plan": plan.model_dump(), "intent": intent})
                return

            if attempt < MAX_RETRIES:
                yield emit({"status": "self_healing", "message": "Syntax error detected — AI is self-healing..."})
                prompt_source = (
                    f"{enriched_prompt}\n\n"
                    f"TypeScript errors:\n\n{ts_error[:1000]}\n\n"
                    "Fix ALL errors and return the FULL updated JSON."
                )
            else:
                final_warning = "Code generated with TypeScript errors."
                break

        yield emit({
            "status": "complete",
            "files": final_files,
            "plan": plan.model_dump(),
            "intent": intent,
            "warning": final_warning,
        })
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
        jupiter_docs = await self._fetch_rag_context(prompt, strategy)

        user_msg = (
            f"Bot name: {intent['bot_name']}\n"
            f"Chain: solana | Network: {network}\n"
            f"Strategy: {strategy}\n"
            f"User intent: {prompt}\n\n"
        )

        if jupiter_docs:
            user_msg += f"=== JUPITER CONTEXT ===\n{jupiter_docs[:CONTEXT_INJECTION_MAX_CHARS]}\n\n"

        user_msg += (
            "ENV VARS: Ensure bot reads JUPITER_API_KEY from process.env.\n"
            f"{chain_ctx}\n\n"
            "Generate exactly 3 files: package.json, tsconfig.json, src/index.ts."
        )

        raw    = self._llm(GENERATOR_SYSTEM, user_msg, temperature=0.1, max_tokens=self.max_tokens)
        parsed = self._parse_json(raw)
        files  = self._assemble_files(parsed.get("files", []), strategy)

        return {
            "status": "ready",
            "intent": intent,
            "output": {"thoughts": parsed.get("thoughts", ""), "files": files},
            "files": files,
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
        """
        Assemble the final file list from LLM output.
        IMPORTANT: We no longer inject mcp_bridge.ts or sns_resolver.ts.
        The generated bot must be 100% standalone using npm packages only.
        """
        normalized: List[Dict[str, Any]] = []
        for f in raw_files if isinstance(raw_files, list) else []:
            if not isinstance(f, dict):
                continue
            fp = _normalize_filepath(f.get("filepath"))
            # Explicitly reject any bridge file injections
            if fp in ("src/mcp_bridge.ts", "src/sns_resolver.ts"):
                _log("WARN", f"Rejected bridge file injection: {fp}")
                continue
            if fp:
                normalized.append({**f, "filepath": fp})

        result: List[Dict[str, Any]] = []
        seen = set()
        for f in normalized:
            result.append(f)
            seen.add(str(f.get("filepath", "")))

        # Ensure package.json is always present with correct deps
        if "package.json" not in seen:
            result.append({
                "filepath": "package.json",
                "content": json.dumps({
                    "name": f"agentia-{strategy.replace('_', '-')}-bot",
                    "version": "1.0.0",
                    "type": "module",
                    "scripts": {"start": "tsx src/index.ts", "build": "tsc"},
                    "dependencies": {
                        "axios": "^1.7.4",
                        "dotenv": "^16.4.0",
                        "@solana/web3.js": "^1.98.0",
                        "@bonfida/spl-name-service": "^3.0.0",
                    },
                    "devDependencies": {
                        "typescript": "^5.4.0",
                        "@types/node": "^20.0.0",
                        "tsx": "^4.7.0",
                    },
                }, indent=2),
            })

        # Ensure tsconfig.json is always present
        if "tsconfig.json" not in seen:
            result.append({
                "filepath": "tsconfig.json",
                "content": json.dumps({
                    "compilerOptions": {
                        "target": "ES2020",
                        "module": "ES2020",
                        "moduleResolution": "node",
                        "outDir": "dist",
                        "rootDir": "src",
                        "strict": True,
                        "esModuleInterop": True,
                        "skipLibCheck": True,
                    },
                    "include": ["src/**/*"],
                }, indent=2),
            })

        # Ensure src/index.ts is always present
        if "src/index.ts" not in seen:
            result.append({
                "filepath": "src/index.ts",
                "content": (
                    'import { config } from "dotenv";\n'
                    'import { fileURLToPath } from "url";\n'
                    'import { dirname, join } from "path";\n'
                    'import { Connection, PublicKey } from "@solana/web3.js";\n\n'
                    'const __filename = fileURLToPath(import.meta.url);\n'
                    'const botDir = dirname(dirname(__filename));\n'
                    'config({ path: join(botDir, ".env") });\n\n'
                    'const connection = new Connection(\n'
                    '  process.env.SOLANA_RPC_URL ?? "https://api.mainnet-beta.solana.com",\n'
                    '  { commitment: "confirmed" }\n'
                    ');\n\n'
                    'async function main(): Promise<void> {\n'
                    '  const wallet = process.env.USER_WALLET_ADDRESS ?? "";\n'
                    '  const lamports = await connection.getBalance(new PublicKey(wallet));\n'
                    '  console.log("SOL balance (lamports):", lamports);\n'
                    '}\n\nvoid main();\n'
                ),
            })

        # Return only the 3 expected files
        wanted = {"package.json", "tsconfig.json", "src/index.ts"}
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
            return {"thoughts": "parse error", "files": []}

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

════════════════════════════════════════
NATIVE DATA QUERY PATTERNS
════════════════════════════════════════

All on-chain reads use @solana/web3.js Connection directly.
There is NO bridge, NO gateway, NO external server at runtime.

SOL BALANCE:
  const lamports = await connection.getBalance(new PublicKey(address));

SPL TOKEN BALANCE (use getParsedTokenAccountsByOwner):
  const accounts = await connection.getParsedTokenAccountsByOwner(
    new PublicKey(walletAddress), {{ mint: new PublicKey(mintAddress) }}
  );
  const rawAmount = accounts.value.length > 0
    ? BigInt(accounts.value[0].account.data.parsed.info.tokenAmount.amount)
    : 0n;

SNS DOMAIN RESOLUTION (@bonfida/spl-name-service):
  import {{ getDomainKey, NameRegistryState }} from "@bonfida/spl-name-service";
  async function resolveSolDomain(domain: string): Promise<string> {{
    if (!domain.endsWith(".sol")) return domain;
    const {{ pubkey }} = await getDomainKey(domain);
    const {{ registry }} = await NameRegistryState.retrieve(connection, pubkey);
    return registry.owner.toBase58();
  }}

JUPITER SWAP EXECUTION (native HTTP — no bridge):
  1. GET  https://quote-api.jup.ag/v6/quote  → quoteResponse
  2. POST https://quote-api.jup.ag/v6/swap   → {{ swapTransaction: "<base64>" }}
  3. VersionedTransaction.deserialize(Buffer.from(swapTransaction, "base64"))
  4. tx.sign([wallet])
  5. connection.sendRawTransaction(tx.serialize(), {{ skipPreflight: true, maxRetries: 2 }})

REQUIRED ENV VARS:
  SOLANA_NETWORK, SOLANA_RPC_URL, SOLANA_KEY,
  USER_WALLET_ADDRESS, TOKEN_MINT_ADDRESS,
  POLL_INTERVAL_MS (default 15000), SIMULATION_MODE (default true)

RULES:
  - All BigInt values are in the token's smallest unit. Never normalize before passing to Jupiter.
  - SIMULATION_MODE=true by default — log swaps, do not execute them.
  - Use inFlight boolean to prevent overlapping poll cycles.
  - Handle SIGINT/SIGTERM gracefully.
  - Never use execSync, child_process, or any local CLI.
  - Include retry logic (withRetry helper) around all network calls.
  - SWAP PAYLOAD must always include dynamicComputeUnitLimit:true + prioritizationFeeLamports.
"""