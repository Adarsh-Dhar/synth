"""
orchestrator.py

Meta-Agent with integrated Planner Agent (Phase 1-4 of the Planner Agent architecture).

Pipeline:
  build_bot(prompt)
    └── orchestrate_bot_creation(chat_history)
          ├── loop:
          │    ├── PlannerAgent.plan(history)        → PlannerState
          │    ├── if needs_mcp_query  → call Solana MCP, inject result, continue
          │    ├── if missing params   → return {status: "clarification_needed"}
          │    └── if ready            → build_bot_logic(enriched_prompt)
          └── build_bot_logic() → 2 files + bridge + ons_resolver
"""

import os
import re
import json
import time
import logging
from concurrent.futures import ThreadPoolExecutor, TimeoutError as FuturesTimeoutError
from pathlib import Path
from typing import Any, Dict, List, Optional

from dotenv import load_dotenv
from azure.ai.inference import ChatCompletionsClient
from azure.ai.inference.models import SystemMessage, UserMessage
from azure.core.credentials import AzureKeyCredential

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


def _log(level: str, message: str, trace_id: Optional[str] = None) -> None:
    prefix = f"[meta-agent] [{level}]"
    if trace_id:
        prefix += f" [{trace_id}]"
    print(f"{prefix} {message}")


# ─── MCP Bridge Template ──────────────────────────────────────────────────────

MCP_BRIDGE_CONTENT = '''\
import "dotenv/config";
import axios from "axios";

    const MCP_GATEWAY_URL = process.env.MCP_GATEWAY_URL ?? "";
    const SOLANA_KEY = process.env.SOLANA_KEY ?? process.env.SOLANA_KEY ?? process.env.SOLANA_KEY ?? "";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeGatewayBase(raw: string): string {
  return String(raw || "").trim().replace(/\\/+$/, "");
}

function buildCandidateUrls(base: string, server: string, tool: string): string[] {
  const withMcp = /\\/mcp$/i.test(base) ? base : base + "/mcp";
  const withoutMcp = withMcp.replace(/\\/mcp$/i, "");
  return [
    `${withMcp}/${server}/${tool}`,
    `${withoutMcp}/${server}/${tool}`,
  ];
}

export async function callMcpTool(
  server: string,
  tool: string,
  args: Record<string, unknown>,
): Promise<unknown> {
    const sessionKey = SOLANA_KEY.trim();
    // Solana MCP shim: session key (if provided) is forwarded via x-session-key
  const rawGateway = normalizeGatewayBase(MCP_GATEWAY_URL);
  if (!rawGateway) {
    throw new Error("MCP_GATEWAY_URL is missing in config/environment");
  }
  const urls = buildCandidateUrls(rawGateway, server, tool);
  const attempts = 3;
  let lastError = "unknown error";

  console.log(`[MCP] → Calling ${server}/${tool}`);
  console.log(`[MCP] Request args: ${JSON.stringify(args)}`);

  for (let attempt = 1; attempt <= attempts; attempt++) {
    for (const url of urls) {
      try {
        console.log(`[MCP] URL: ${url} (attempt ${attempt}/${attempts})`);
        const response = await axios.post(url, args, {
                        headers: {
                        "Content-Type": "application/json",
                        ...(sessionKey ? { "x-session-key": sessionKey } : {}),
                        "ngrok-skip-browser-warning": "true",
                        "Bypass-Tunnel-Reminder": "true",
                    },
          timeout: 10_000,
        });

        const data = response.data;
        console.log(`[MCP] ✓ Response received:`, JSON.stringify(data).substring(0, 200));
        const result = (data as { result?: { isError?: boolean; content?: unknown } })?.result;
        if (result?.isError) {
          const content = result.content;
          const detail = Array.isArray(content) && content.length > 0
            ? String((content[0] as { text?: unknown }).text ?? JSON.stringify(content))
            : JSON.stringify(content ?? data);
          throw new Error(`MCP ${server}/${tool} error: ${detail}`);
        }
        return data;
      } catch (err) {
        const status = (err as any)?.response?.status ?? 0;
        const errText = (err as any)?.response?.data ?? (err instanceof Error ? err.message : String(err));
        lastError = `MCP ${server}/${tool} failed: ${status} — ${errText}`;
        console.error(`[MCP] ✗ Error: ${lastError}`);
        if (status === 404) {
          continue;
        }
        break;
      }
    }
    if (attempt < attempts) await sleep(400 * attempt);
  }
  throw new Error(`MCP ${server}/${tool} unavailable after retries: ${lastError}`);
}

export async function getFaBalance(network: string, walletAddress: string, metadataAddress: string): Promise<bigint> {
  try {
        const payload = await callMcpTool("solana", "move_view", {
            network,
            address: "0x1",
            module: "primary_fungible_store",
            function: "balance",
            type_args: ["0x1::fungible_asset::Metadata"],
            args: [walletAddress, metadataAddress]
        });
    const str = JSON.stringify(payload || {});
    const match = str.match(/"(?:balance|amount|value|coin_amount)"\\s*:\\s*"(\\d+)"/) || str.match(/\\[\\s*"(\\d+)"\\s*\\]/);
    return match ? BigInt(match[1]) : 0n;
  } catch (err) {
    console.warn("Failed to get FA balance:", err instanceof Error ? err.message : String(err));
    return 0n;
  }
}
'''

ONS_RESOLVER_CONTENT = '''\
import { callMcpTool } from "./mcp_bridge.js";
import "dotenv/config";

const _resolvedCache = new Map<string, string>();

export function isSolName(value: string): boolean {
    return /^[a-z0-9_-]+\\.sol$/i.test(String(value ?? "").trim());
}

function extractAddressFromPayload(payload: unknown): string | null {
  if (!payload || typeof payload !== "object") return null;
  const root = payload as Record<string, unknown>;
  for (const field of ["address", "resolved_address", "value", "account"]) {
    if (typeof root[field] === "string" && (root[field] as string).trim()) {
      return (root[field] as string).trim();
    }
  }
  const result = root.result;
  if (result && typeof result === "object") {
    const content = (result as Record<string, unknown>).content;
    if (Array.isArray(content) && content.length > 0) {
      const text = (content[0] as Record<string, unknown>).text;
      if (typeof text === "string") {
        const trimmed = text.trim();
        if (trimmed.startsWith("{")) {
          try {
            const inner = JSON.parse(trimmed) as Record<string, unknown>;
            for (const field of ["address", "resolved_address", "value"]) {
              if (typeof inner[field] === "string") return (inner[field] as string).trim();
            }
          } catch {}
        }
                // Heuristic: treat base58-looking strings as Solana addresses
                if (/^[1-9A-HJ-NP-Za-km-z]{32,64}$/.test(trimmed)) {
                    return trimmed;
                }
      }
    }
  }
  return null;
}

export async function resolveAddress(nameOrAddress: string): Promise<string> {
  const normalized = String(nameOrAddress ?? "").trim().toLowerCase();
    if (!isSolName(normalized)) {
    return String(nameOrAddress ?? "").trim();
  }
  const cached = _resolvedCache.get(normalized);
  if (cached) {
    return cached;
  }
    const response = await callMcpTool("solana", "move_view", {
        network: String(process.env.SOLANA_NETWORK ?? process.env.SOLANA_NETWORK ?? process.env.SOLANA_NETWORK ?? "devnet"),
        address: String(process.env.SNS_REGISTRY_ADDRESS ?? process.env.ONS_REGISTRY_ADDRESS ?? ""),
        module: "name_service",
        function: "resolve",
        type_args: [],
        args: [normalized],
    });
  const resolved = extractAddressFromPayload(response);
  if (!resolved) {
    throw new Error(`ONS registry returned no address for \'${normalized}\'`);
  }
  _resolvedCache.set(normalized, resolved);
  return resolved;
}
'''


# ─── Classifier ───────────────────────────────────────────────────────────────

CLASSIFIER_SYSTEM = """\
You are a DeFi bot intent classifier.
Analyze the prompt and return ONLY valid JSON — no markdown, no preamble.

Schema:
{
    "chain": "solana",
        "network": "solana-devnet",
    "strategy": "arbitrage" | "sentiment" | "sniping" | "dca" | "grid" | "whale_mirror" | "yield" | "yield_sweeper" | "cross_chain_liquidation" | "cross_chain_arbitrage" | "cross_chain_sweep" | "custom_utility" | "perp" | "unknown",
    "mcps": ["list of MCP server names to use"],
    "bot_name": "human-readable name",
    "requires_openai": true | false
}

Rules:
- ALWAYS set chain:"solana"
- yield sweeper / auto-consolidator / sweep idle funds → strategy:"yield", mcps:["solana"]
- cross-chain liquidation → strategy:"cross_chain_liquidation", mcps:["solana"]
- flash-bridge arbitrage → strategy:"cross_chain_arbitrage", mcps:["solana"]
- omni-chain yield → strategy:"cross_chain_sweep", mcps:["solana"]
- custom utility → strategy:"custom_utility", mcps:["solana"]
- sentiment/social → requires_openai:true
- default network: solana-devnet
"""


def _normalize_strategy(strategy: str) -> str:
    value = str(strategy or "").strip().lower()
    aliases: Dict[str, str] = {
        "yield_sweeper": "yield",
        "yield-sweeper": "yield",
        "cross_chain_liquidation": "cross_chain_liquidation",
        "cross-chain-liquidation": "cross_chain_liquidation",
        "liquidation_sniper": "cross_chain_liquidation",
        "omni_chain_liquidator": "cross_chain_liquidation",
        "cross_chain_arbitrage": "cross_chain_arbitrage",
        "cross-chain-arbitrage": "cross_chain_arbitrage",
        "flash_bridge": "cross_chain_arbitrage",
        "spatial_arb": "cross_chain_arbitrage",
        "cross_chain_sweep": "cross_chain_sweep",
        "cross-chain-sweep": "cross_chain_sweep",
        "yield_nomad": "cross_chain_sweep",
        "auto_compounder": "cross_chain_sweep",
        "custom": "custom_utility",
        "custom_utility": "custom_utility",
        "custom-utility": "custom_utility",
        "spread_scanner": "arbitrage",
    }
    return aliases.get(value, value or "unknown")


def _normalize_generated_filepath(raw_path: object) -> str:
    path = str(raw_path or "").strip().replace("\\", "/")
    if not path:
        return ""
    path = re.sub(r"^[./]+", "", path)
    if not path:
        return ""
    lower_path = path.lower()
    base = lower_path.split("/")[-1]
    alias_map = {
        "package.json": "package.json",
        "index.ts": "src/index.ts",
        "main.ts": "src/index.ts",
        "mcp_bridge.ts": "src/mcp_bridge.ts",
        "ons_resolver.ts": "src/ons_resolver.ts",
    }
    if lower_path in alias_map:
        return alias_map[lower_path]
    if base in alias_map:
        return alias_map[base]
    return path


# ─── Generator System Prompt ─────────────────────────────────────────────────

GENERATOR_SYSTEM = """\
You are an expert Solana bot engineer. Generate production-ready TypeScript for the Agentia platform.

OUTPUT FORMAT - CRITICAL:
Respond with RAW JSON only. No markdown fences. No preamble. No trailing text.

Schema:
{
  "thoughts": "<one paragraph: architecture rationale>",
  "files": [
    {"filepath": "package.json", "content": "..."},
    {"filepath": "src/index.ts", "content": "..."}
  ]
}

You MUST generate EXACTLY these 2 files in this order:
  1. package.json
  2. src/index.ts

The file src/mcp_bridge.ts is provided separately - do NOT generate it.
"Import tools in src/index.ts as: import { callMcpTool, getFaBalance } from './mcp_bridge.js'.\n"
"Do NOT write your own balance fetching logic. Always use getFaBalance(network, walletAddress, metadataAddress) for token balances."
Do NOT generate src/config.ts. Read all values directly from process.env inside src/index.ts.

CORE CONSTRAINTS:
1. TypeScript + Node.js only.
2. package.json must use "type": "module" and "start": "tsx src/index.ts".
3. Minimal dependencies: axios (for HTTP), dotenv, tsx, typescript, @types/node only.
4. Import "dotenv/config" at top of src/index.ts. Read all secrets from process.env.
5. All money math uses BigInt only — no floats.
6. SIMULATION_MODE defaults to true unless explicitly "false".
7. Use a guarded scheduler (inFlight flag) to prevent concurrent cycles.
8. Add graceful SIGINT/SIGTERM shutdown.
9. Every generated file must be complete — no TODOs or stubs.
10. Never use fake placeholder addresses.
11. SOLANA_KEY may be injected at runtime; do not fail at startup if missing.
12. All verified on-chain data injected in the prompt MUST be used directly.
13. CRITICAL: Use axios for all HTTP/HTTPS requests. Do NOT use fetch. Axios avoids WebContainer sandbox issues.
14. Include axios: "^1.7.4" in package.json dependencies.

SOLANA RULES:
- Prefer Solana-native code using `@solana/web3.js` and the Solana MCP shim when appropriate.
- For MCP-style reads during migration use `callMcpTool('solana', 'move_view', {...})`.
- For direct balance queries prefer `callMcpTool('solana', 'get_balance', {address})` or `callMcpTool('solana', 'get_token_balance', {owner, mint})`.
- All writes must be explicit Solana transactions signed by a wallet (Phantom) in the frontend; server-side simulated execution may use `send_raw_transaction`.
- Use verified addresses from the enriched prompt — never invent them.
"""


# ─── MetaAgent ────────────────────────────────────────────────────────────────

class MetaAgent:
    def __init__(self):
        token = os.environ.get("GITHUB_TOKEN")
        if not token:
            raise ValueError("GITHUB_TOKEN not set in .env")

        self.client = ChatCompletionsClient(
            endpoint=os.environ.get(
                "GITHUB_MODEL_ENDPOINT", "https://models.inference.ai.azure.com"
            ),
            credential=AzureKeyCredential(token),
        )
        self.model      = os.environ.get("GITHUB_MODEL_NAME", "gpt-4o")
        self.planner_model = os.environ.get("PLANNER_MODEL_NAME", "gpt-4o-mini")
        self.max_tokens = int(os.environ.get("GENERATION_MAX_TOKENS", "2048"))
        self.mcp_client = SolanaMCPClient()
        self.planner    = PlannerAgent(llm_caller=self._llm)

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
        started_at = time.monotonic()
        model_name = self.planner_model if operation == "planner" else self.model

        def _is_retryable_error(exc: Exception) -> bool:
            text = str(exc).lower()
            retryable_markers = (
                "connection aborted",
                "remotedisconnected",
                "remote end closed connection",
                "service response error",
                "connection reset",
                "temporarily unavailable",
                "read timed out",
                "timed out",
                "503",
                "502",
            )
            return any(marker in text for marker in retryable_markers)

        def _complete():
            return self.client.complete(
                messages=[
                    SystemMessage(content=system),
                    UserMessage(content=user),
                ],
                model=model_name,
                temperature=temperature,
                max_tokens=max_tokens,
            )

        max_attempts = max(1, LLM_MAX_RETRIES + 1)
        attempt = 1
        while True:
            executor = ThreadPoolExecutor(max_workers=1)
            future = None
            try:
                _log(
                    "INFO",
                    f"{operation}: attempt={attempt}/{max_attempts} model={model_name} system_chars={len(system)} "
                    f"user_chars={len(user)} max_tokens={max_tokens} timeout={LLM_TIMEOUT_SECONDS}s",
                    trace_id,
                )
                future = executor.submit(_complete)
                response = future.result(timeout=LLM_TIMEOUT_SECONDS)
                executor.shutdown(wait=False, cancel_futures=True)
                break
            except FuturesTimeoutError:
                if future is not None:
                    future.cancel()
                executor.shutdown(wait=False, cancel_futures=True)
                elapsed = round(time.monotonic() - started_at, 2)
                msg = (
                    f"LLM timeout after {LLM_TIMEOUT_SECONDS}s for {operation} "
                    f"(model={model_name}, elapsed={elapsed}s)"
                )
                _log("ERROR", msg, trace_id)
                raise TimeoutError(msg)
            except Exception as exc:
                executor.shutdown(wait=False, cancel_futures=True)
                elapsed = round(time.monotonic() - started_at, 2)
                retryable = _is_retryable_error(exc)
                if retryable and attempt < max_attempts:
                    sleep_s = round(LLM_RETRY_BASE_DELAY * attempt, 2)
                    _log(
                        "WARN",
                        f"{operation}: transient failure on attempt {attempt}/{max_attempts} "
                        f"({exc.__class__.__name__}: {exc}); retrying in {sleep_s}s",
                        trace_id,
                    )
                    time.sleep(sleep_s)
                    attempt += 1
                    continue
                _log(
                    "ERROR",
                    f"{operation}: failed after {elapsed}s with {exc.__class__.__name__}: {exc}",
                    trace_id,
                )
                raise

        content = response.choices[0].message.content
        elapsed = round(time.monotonic() - started_at, 2)
        _log("INFO", f"{operation}: completed in {elapsed}s", trace_id)
        return content.strip() if isinstance(content, str) else str(content)

    # ── Planner Orchestration Loop (Phase 4) ───────────────────────────────────

    def orchestrate_bot_creation(
        self,
        chat_history: List[Dict[str, str]],
        trace_id: Optional[str] = None,
    ) -> Dict[str, Any]:
        """
        Core Planner → MCP → Code Generator loop.

        Returns one of:
          {"status": "clarification_needed", "question": "<string>"}
          {"status": "ready", "intent": {...}, "output": {"thoughts": ..., "files": [...]}}
          {"status": "error", "message": "<string>"}
        """
        history = list(chat_history)  # local copy we mutate with MCP results

        for loop_idx in range(PLANNER_MAX_LOOPS):
            _log("INFO", f"Planner loop {loop_idx + 1}/{PLANNER_MAX_LOOPS}", trace_id)

            # ── Step 1: Ask Planner LLM ───────────────────────────────────────
            try:
                plan: PlannerState = self.planner.plan(history, trace_id=trace_id)
            except Exception as exc:
                _log("ERROR", f"Planner LLM failed: {exc}", trace_id)
                return {"status": "error", "message": str(exc)}

            _log(
                "INFO",
                f"Plan: strategy={plan.strategy_type} "
                f"ready={plan.is_ready_for_code_generation} "
                f"mcp_needed={plan.verification_step.needs_mcp_query if plan.verification_step else False} "
                f"missing={plan.missing_parameters}",
                trace_id,
            )

            # ── Step 2: On-Chain Verification via Solana MCP ──────────────────
            vs = plan.verification_step
            if vs and vs.needs_mcp_query and vs.mcp_payload:
                purpose = vs.verification_purpose or "on-chain verification"
                _log("INFO", f"Querying Solana MCP for: {purpose}", trace_id)
                _log(
                    "INFO",
                    f"MCP payload: {json.dumps(vs.mcp_payload, separators=(',', ':'))}",
                    trace_id,
                )

                try:
                    mcp_result = self.mcp_client.move_view(vs.mcp_payload)
                    summary    = summarise_mcp_result(purpose, vs.mcp_payload, mcp_result)
                    _log("INFO", f"MCP result summary: {summary}", trace_id)
                except Exception as exc:
                    # MCP unreachable or returned error — inject as warning and continue
                    summary = (
                        f"MCP Verification [{purpose}] FAILED: {exc}. "
                        "The planner should proceed without this verification or ask the user."
                    )
                    _log("WARN", summary, trace_id)

                # Inject MCP result back into history for the next Planner loop
                history.append({"role": "system", "content": summary})
                continue  # Re-run Planner with enriched context

            # ── Step 3: Human-in-the-Loop — missing parameters ────────────────
            if not plan.is_ready_for_code_generation:
                question = (
                    plan.clarifying_question_for_user
                    or "Could you provide more details about the addresses or parameters needed?"
                )
                _log("INFO", f"Clarification needed: {question}", trace_id)
                return {"status": "clarification_needed", "question": question}

            # ── Step 4: Code Generation — all params collected and verified ────
            if plan.is_ready_for_code_generation:
                enriched = plan.enriched_prompt or history[-1].get("content", "")
                _log("INFO", "All parameters verified. Proceeding to code generation.", trace_id)
                return self._generate_code_with_plan(plan, enriched, trace_id)

        # Exhausted loops without resolution
        _log(
            "WARN",
            f"Planner loop limit ({PLANNER_MAX_LOOPS}) reached without resolution.",
            trace_id,
        )
        return {
            "status": "clarification_needed",
            "question": (
                "I need a bit more information to build your bot correctly. "
                "Could you describe the specific pools, tokens, or addresses you want to use?"
            ),
        }

    # ── Code Generation ────────────────────────────────────────────────────────

    def _generate_code_with_plan(
        self,
        plan: PlannerState,
        enriched_prompt: str,
        trace_id: Optional[str] = None,
    ) -> Dict[str, Any]:
        """Invoke the code generator with a verified, enriched prompt."""
        # Build intent from the plan
        intent = {
            "chain": "solana",
            "network": plan.collected_parameters.get("SOLANA_NETWORK", "devnet"),
            "strategy": plan.strategy_type,
            "mcps": ["solana"],
            "bot_name": self._derive_bot_name(plan.strategy_type),
            "requires_openai": plan.strategy_type == "sentiment",
            "collected_parameters": plan.collected_parameters,
        }

        chain_ctx = self._chain_context("solana", intent["network"], ["solana"], plan.strategy_type)
        user_msg  = (
            f"Bot name: {intent['bot_name']}\n"
            f"Chain: solana | Network: {intent['network']}\n"
            f"Strategy: {plan.strategy_type}\n"
            f"MCP servers to use: solana\n"
            f"Verified on-chain parameters:\n"
            + "\n".join(f"  {k}={v}" for k, v in plan.collected_parameters.items())
            + f"\n\nOriginal user intent: {enriched_prompt}\n\n{chain_ctx}\n\nGenerate the 2 files now."
        )

        _log(
            "INFO",
            f"_generate_code_with_plan: generator_prompt_chars={len(user_msg)}",
            trace_id,
        )
        raw    = self._llm(GENERATOR_SYSTEM, user_msg, temperature=0.1, max_tokens=self.max_tokens)
        parsed = self._parse_response(raw)

        if "files" not in parsed:
            parsed["files"] = []

        files          = self._normalize_files(parsed.get("files", []))
        files          = self._inject_bridge_files(files, plan.strategy_type)
        files          = self._ensure_required_files(files)
        wanted         = {"package.json", "src/index.ts", "src/mcp_bridge.ts", "src/ons_resolver.ts"}
        final_files    = [f for f in files if str(f.get("filepath", "")) in wanted]

        _log("INFO", f"Generated files: {[f.get('filepath') for f in final_files]}", trace_id)

        return {
            "status": "ready",
            "intent": intent,
            "output": {
                "thoughts": parsed.get("thoughts", ""),
                "files": final_files,
            },
        }

    # ── Public entry points ────────────────────────────────────────────────────

    def classify_intent(self, prompt: str, trace_id: Optional[str] = None) -> Dict[str, Any]:
        """
        Quick intent classification (used when Planner is disabled or for the
        first turn of a single-shot /create-bot call).
        """
        _log("INFO", f"classify_intent: prompt_chars={len(prompt)}", trace_id)
        raw = self._llm(
            CLASSIFIER_SYSTEM,
            prompt,
            temperature=0.0,
            max_tokens=512,
            operation="classify_intent",
            trace_id=trace_id,
        )
        raw = re.sub(r"```(?:json)?\s*|\s*```", "", raw).strip()
        try:
            intent = json.loads(raw)
        except Exception:
            intent = {
                "chain": "solana",
                "network": "devnet",
                "strategy": "custom_utility",
                "mcps": ["solana"],
                "bot_name": "Custom Utility Solana Bot",
                "requires_openai": False,
            }

        mcps      = [str(m).strip().lower() for m in intent.get("mcps", []) if str(m).strip()]
        strategy  = _normalize_strategy(str(intent.get("strategy", "")))
        intent["chain"]    = "solana"
        intent["strategy"] = strategy
        intent["mcps"]     = ["solana"]

        intent["network"] = "devnet"
        return intent

    def build_bot(self, prompt: str, trace_id: Optional[str] = None) -> Dict[str, Any]:
        """
        Single-shot entry point (used by /create-bot without chat history).
        Wraps the Planner Orchestration Loop with a seeded single-turn history.
        """
        _log("INFO", f"build_bot: prompt_chars={len(prompt)}", trace_id)

        if PLANNER_ENABLED:
            # Seed the orchestration loop with the user prompt as the first turn
            initial_history: List[Dict[str, str]] = [{"role": "user", "content": prompt}]
            result = self.orchestrate_bot_creation(initial_history, trace_id=trace_id)

            if result.get("status") == "ready":
                return result

            if result.get("status") == "clarification_needed":
                # In single-shot mode, fall through to direct generation rather
                # than returning a mid-generation pause (the caller doesn't support it).
                _log(
                    "WARN",
                    "Planner requested clarification in single-shot mode — "
                    "falling back to direct generation.",
                    trace_id,
                )
                # Fall through to legacy direct generation below

        # ── Legacy direct generation (Planner disabled or clarification fallback)
        intent     = self.classify_intent(prompt, trace_id=trace_id)
        strategy   = str(intent.get("strategy", "unknown"))
        network    = str(intent.get("network", "devnet"))
        mcps       = ["solana"]
        bot_name   = str(intent.get("bot_name", "Agentia Solana Bot"))
        chain_ctx  = self._chain_context("solana", network, mcps, strategy)

        user_msg = (
            f"Bot name: {bot_name}\n"
            f"Chain: solana | Network: {network}\n"
            f"Strategy: {strategy}\n"
            f"MCP servers to use: solana\n"
            f"Original user intent: {prompt}\n\n"
            f"{chain_ctx}\n\nGenerate the 2 files now."
        )

        _log(
            "INFO",
            f"build_bot(legacy): generator_prompt_chars={len(user_msg)}",
            trace_id,
        )
        raw    = self._llm(GENERATOR_SYSTEM, user_msg, temperature=0.1, max_tokens=self.max_tokens)
        parsed = self._parse_response(raw)

        if "files" not in parsed:
            parsed["files"] = []

        files       = self._normalize_files(parsed.get("files", []))
        files       = self._inject_bridge_files(files, strategy)
        files       = self._ensure_required_files(files)
        wanted      = {"package.json", "src/index.ts", "src/mcp_bridge.ts", "src/ons_resolver.ts"}
        final_files = [f for f in files if str(f.get("filepath", "")) in wanted]

        _log("INFO", f"build_bot: final_files={[f.get('filepath') for f in final_files]}", trace_id)

        return {
            "status": "ready",
            "intent": intent,
            "output": {
                "thoughts": parsed.get("thoughts", ""),
                "files": final_files,
            },
        }

    def build_bot_with_history(
        self,
        chat_history: List[Dict[str, str]],
        trace_id: Optional[str] = None,
    ) -> Dict[str, Any]:
        """
        Multi-turn entry point used by the /create-bot-chat endpoint.
        Passes the full conversation history through the Planner loop.
        """
        _log("INFO", f"build_bot_with_history: turns={len(chat_history)}", trace_id)
        return self.orchestrate_bot_creation(chat_history, trace_id=trace_id)

    # ── File assembly helpers ──────────────────────────────────────────────────

    def _normalize_files(self, raw_files: Any) -> List[Dict[str, Any]]:
        normalized: List[Dict[str, Any]] = []
        for raw_file in raw_files if isinstance(raw_files, list) else []:
            if not isinstance(raw_file, dict):
                continue
            path = _normalize_generated_filepath(raw_file.get("filepath"))
            if not path:
                continue
            normalized.append({**raw_file, "filepath": path})
        return normalized

    def _inject_bridge_files(
        self, files: List[Dict[str, Any]], strategy: str
    ) -> List[Dict[str, Any]]:
        existing = {str(f.get("filepath", "")) for f in files}

        # Always enforce canonical mcp_bridge
        patched = []
        for f in files:
            if str(f.get("filepath", "")) == "src/mcp_bridge.ts":
                patched.append({**f, "content": MCP_BRIDGE_CONTENT})
            else:
                patched.append(f)
        files = patched

        existing = {str(f.get("filepath", "")) for f in files}

        if "src/mcp_bridge.ts" not in existing:
            files.append({"filepath": "src/mcp_bridge.ts", "content": MCP_BRIDGE_CONTENT})
        if "src/ons_resolver.ts" not in existing:
            files.append({"filepath": "src/ons_resolver.ts", "content": ONS_RESOLVER_CONTENT})
        return files

    def _ensure_required_files(self, files: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
        existing = {str(f.get("filepath", "")) for f in files}

        if "package.json" not in existing:
            files.append({
                "filepath": "package.json",
                "content": json.dumps(
                    {
                        "name": "agentia-solana-bot",
                        "version": "1.0.0",
                        "type": "module",
                        "scripts": {"start": "tsx src/index.ts", "dev": "tsx src/index.ts"},
                        "dependencies": {"dotenv": "^16.4.0"},
                        "devDependencies": {
                            "typescript": "^5.4.0",
                            "@types/node": "^20.0.0",
                            "tsx": "^4.7.0",
                        },
                    },
                    indent=2,
                    ),
            })

        if "src/index.ts" not in existing:
            files.append({
                "filepath": "src/index.ts",
                "content": (
                    'import "dotenv/config";\n'
                    'import { callMcpTool } from "./mcp_bridge.js";\n\n'
                    'async function main(): Promise<void> {\n'
                    '  const payload = await callMcpTool("solana", "move_view", {\n'
                    '    network: String(process.env.SOLANA_NETWORK ?? process.env.SOLANA_NETWORK ?? process.env.SOLANA_NETWORK ?? "devnet"),\n'
                    '    address: "",\n'
                    '    module: "coin",\n'
                    '    function: "balance",\n'
                    '    type_args: [],\n'
                    '    args: [String(process.env.USER_WALLET_ADDRESS ?? "")],\n'
                    '  });\n'
                    '  console.log(JSON.stringify(payload));\n'
                    '}\n\n'
                    'void main();\n'
                ),
            })
        return files

    # ── Response parsing ───────────────────────────────────────────────────────

    def _parse_response(self, raw: str) -> Dict[str, Any]:
        start = raw.find("{")
        end   = raw.rfind("}")
        if start != -1 and end != -1:
            raw = raw[start : end + 1]
        raw = re.sub(r",\s*([}\]])", r"\1", raw)
        try:
            from json_repair import loads as repair_loads  # type: ignore
            result = repair_loads(raw)
            if isinstance(result, str):
                result = json.loads(result)
            return result if isinstance(result, dict) else {}
        except Exception:
            pass
        try:
            return json.loads(raw)
        except Exception:
            return {"thoughts": "parse error", "files": [{"filepath": "error.ts", "content": raw}]}

    # ── Helpers ────────────────────────────────────────────────────────────────

    @staticmethod
    def _derive_bot_name(strategy: str) -> str:
        names = {
            "yield":                  "Cross-Rollup Yield Sweeper",
            "yield_sweeper":          "Cross-Rollup Yield Sweeper",
            "arbitrage":              "Cross-Rollup Spread Scanner",
            "cross_chain_liquidation":"Omni-Chain Liquidation Sniper",
            "cross_chain_arbitrage":  "Flash-Bridge Spatial Arbitrageur",
            "cross_chain_sweep":      "Omni-Chain Yield Nomad",
            "sentiment":              "Solana Sentiment Bot",
            "custom_utility":         "Custom Utility Solana Bot",
        }
        return names.get(strategy, "Agentia Solana Bot")

    def _chain_context(
        self, chain: str, network: str, mcps: List[str], strategy: str
    ) -> str:
        if chain != "solana":
            return ""
        strategy_lc = str(strategy or "").lower()
        is_yield    = strategy_lc in {"yield", "yield_sweeper"}
        is_cross    = "cross_chain" in strategy_lc

        mcp_hints = (
            "\nWrite: callMcpTool('solana', 'send_raw_transaction', {transaction})"
            "\nRead:  callMcpTool('solana', 'get_balance', {address}) or callMcpTool('solana', 'get_token_balance', {owner, mint})"
            "\nRule:  MCP shim returns JSON objects for compat payloads."
            "\nCRITICAL RULE FOR FA BALANCES: Use the token account / mint pair to query SPL balances via the MCP shim."
        )

        bridge_schema = ""
        if is_yield or is_cross:
            bridge_schema = """
Solana Bridge schema (example):
    Use native SystemProgram.transfer for SOL transfers or Wormhole/Portal bridges for cross-chain messaging.
    For token transfers use SPL token instructions and known bridge program IDs when needed.
"""

        return f"""
CHAIN CONTEXT — SOLANA ({network})
Network IDs: devnet=devnet

MCP tool signatures:
{mcp_hints}
{bridge_schema}
Required env vars:
    SOLANA_POOL_A_ADDRESS, SOLANA_POOL_B_ADDRESS, USER_WALLET_ADDRESS,
    SOLANA_BRIDGE_ADDRESS, SOLANA_USDC_METADATA_ADDRESS,
    SOLANA_SWAP_ROUTER_ADDRESS, SOLANA_EXECUTION_AMOUNT_USDC,
    SOLANA_MOCK_ORACLE_ADDRESS, SOLANA_MOCK_LENDING_ADDRESS,
    SOLANA_LIQUIDATION_WATCHLIST

Solana read/write patterns: prefer native RPC calls or the MCP shim compatibility endpoints.
"""