"""
agents/copilot_planner.py  (v2 — hardened)

Copilot-style ReAct (Reason + Act) Planning Agent.

Changes from v1:
  - Infinite loop protection: if REACT_MAX_ITERATIONS exhausted without
    finish/ask_user, we synthesise a finish step from whatever we have.
  - Max-iteration event is surfaced as a structured response, not a hang.
  - Improved tool-call JSON parsing with fallback heuristics.
  - ask_user loop-break now also resets iteration so resumption works.
  - query_onchain results absorbed into confirmed_parameters immediately.
  - emit_plan step sets strategy even if LLM omits it.
"""

from __future__ import annotations

import json
import logging
import os
import re
import time
from typing import Any, Dict, List, Optional, Tuple

import httpx
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

logger = logging.getLogger(__name__)

# ─── Configuration ────────────────────────────────────────────────────────────

REACT_MAX_ITERATIONS = int(os.environ.get("REACT_MAX_ITERATIONS", "10"))
REACT_LLM_TIMEOUT    = int(os.environ.get("REACT_LLM_TIMEOUT_SECONDS", "60"))
REACT_MODEL          = os.environ.get("REACT_MODEL_NAME", "gpt-4o-mini")

# ─── Tool Definitions ─────────────────────────────────────────────────────────

COPILOT_TOOLS: List[Dict[str, Any]] = [
    {
        "name": "think",
        "description": (
            "Internal reasoning step. Use this to plan your next action, "
            "evaluate what information you have vs. what you need, and decide "
            "what tool to call next. This is your scratchpad — the user does NOT see it."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "reasoning": {"type": "string"},
                "have": {"type": "array", "items": {"type": "string"}},
                "need": {"type": "array", "items": {"type": "string"}},
                "next_action": {
                    "type": "string",
                    "enum": ["ask_user", "query_onchain", "search_docs", "emit_plan", "finish"],
                },
            },
            "required": ["reasoning", "next_action"],
        },
    },
    {
        "name": "ask_user",
        "description": (
            "Pause execution and ask the user ONE focused clarifying question. "
            "Use ONLY when a required parameter is genuinely missing. "
            "Do NOT ask for optional parameters — use sensible defaults."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "question": {"type": "string"},
                "parameter_name": {"type": "string"},
                "examples": {"type": "array", "items": {"type": "string"}},
                "optional": {"type": "boolean"},
            },
            "required": ["question", "parameter_name"],
        },
    },
    {
        "name": "query_onchain",
        "description": (
            "Query the Solana MCP server to verify on-chain data. "
            "Always verify wallet addresses and token mints before embedding them in code."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "tool": {
                    "type": "string",
                    "enum": ["get_balance", "get_token_balance", "get_account_info", "resolve_sns"],
                },
                "payload": {"type": "object"},
                "purpose": {"type": "string"},
            },
            "required": ["tool", "payload", "purpose"],
        },
    },
    {
        "name": "emit_plan",
        "description": (
            "Emit a structured plan before writing any code. "
            "Call ONCE after all required parameters are confirmed."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "strategy": {"type": "string"},
                "bot_name": {"type": "string"},
                "network": {"type": "string"},
                "confirmed_parameters": {"type": "object"},
                "architecture": {"type": "array", "items": {"type": "string"}},
                "files_to_generate": {"type": "array", "items": {"type": "string"}},
            },
            "required": ["strategy", "bot_name", "network", "confirmed_parameters", "architecture"],
        },
    },
    {
        "name": "finish",
        "description": (
            "Signal readiness to generate code. "
            "Only call AFTER emit_plan has been called."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "enriched_prompt": {"type": "string"},
                "strategy": {"type": "string"},
                "confirmed_parameters": {"type": "object"},
            },
            "required": ["enriched_prompt", "strategy", "confirmed_parameters"],
        },
    },
]


# ─── Pydantic models ──────────────────────────────────────────────────────────

class CopilotStep(BaseModel):
    step_type: str
    tool_name: str
    tool_args: Dict[str, Any] = Field(default_factory=dict)
    result: Optional[Dict[str, Any]] = None
    timestamp: float = Field(default_factory=time.time)


class CopilotState(BaseModel):
    session_id: str
    original_request: str
    message_history: List[Dict[str, str]] = Field(default_factory=list)
    confirmed_parameters: Dict[str, str] = Field(default_factory=dict)
    steps: List[CopilotStep] = Field(default_factory=list)
    strategy: Optional[str] = None
    is_complete: bool = False
    is_waiting_for_user: bool = False
    pending_question: Optional[str] = None
    pending_parameter: Optional[str] = None
    plan_emitted: bool = False
    final_enriched_prompt: Optional[str] = None
    iteration: int = 0
    # New: tracks whether max-iter fallback was triggered
    hit_max_iterations: bool = False


# ─── System prompt ────────────────────────────────────────────────────────────

COPILOT_SYSTEM = """\
You are an expert Solana DeFi bot architect — a copilot that helps developers build
autonomous trading bots. You reason step-by-step before writing any code.

## Your Workflow (STRICT — follow this order every time)

1. **THINK FIRST** — Always call `think` as your first action.
   - Assess what you know vs. what you need.
   - Identify the strategy type from the user's message.
   - List required parameters for that strategy.
   - Decide your next action.

2. **ASK FOR MISSING REQUIRED PARAMS** — If a required parameter is missing, call `ask_user`.
   - Ask ONE question at a time.
   - Never ask for optional params — use defaults.
   - Never guess wallet addresses or token mints.

3. **VERIFY ON-CHAIN** — Call `query_onchain` to verify any addresses provided.
   - Always verify wallet addresses exist on Solana.
   - Always verify token mint accounts are valid.

4. **EMIT A PLAN** — Once all params are confirmed, call `emit_plan`.
   - Show the user what you're about to build.
   - List architecture decisions.

5. **FINISH** — Call `finish` with the enriched prompt for code generation.

## Strategy → Required Parameters

| Strategy | Required Parameters |
|----------|-------------------|
| yield_sweeper | USER_WALLET_ADDRESS, TOKEN_MINT_ADDRESS, SOLANA_NETWORK |
| arbitrage | POOL_ADDRESS, TOKEN_MINT_ADDRESS, TRADE_AMOUNT_LAMPORTS, USER_WALLET_ADDRESS, MIN_PROFIT_LAMPORTS |
| sniping | TOKEN_MINT_ADDRESS, USER_WALLET_ADDRESS, TRADE_AMOUNT_LAMPORTS |
| dca | TOKEN_MINT_ADDRESS, USER_WALLET_ADDRESS, TRADE_AMOUNT_LAMPORTS |
| liquidation | PROGRAM_ID, USER_WALLET_ADDRESS |
| yield_sweeper (Kamino/sUSDe) | USER_WALLET_ADDRESS — mints are HARDCODED, never ask |

## Yield Sweeper Special Rules (Kamino ↔ sUSDe)
If the user mentions "yield", "sweep", "Kamino", "sUSDe", "APY comparison":
- Strategy = yield_sweeper
- USDC mint: EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v (never ask)
- sUSDe mint: G9W2WBKV3nJULX4kz47HCJ75jnVG4RYWZj5q5U5kXfz (never ask)
- SOL mint: So11111111111111111111111111111111111111112 (never ask)
- Only ask for: USER_WALLET_ADDRESS, optional threshold (default 1.5%), optional poll interval (default 60s)

## Defaults (never ask for these)
- SOLANA_NETWORK: mainnet-beta
- POLL_INTERVAL_MS: 60000
- SIMULATION_MODE: true (safe by default)
- REBALANCE_THRESHOLD_PCT: 1.5
- MCP_GATEWAY_URL: http://127.0.0.1:8001

## Rules
- NEVER generate code until `finish` is called.
- NEVER guess wallet addresses or mints — always ask or use hardcoded values.
- NEVER call `finish` without first calling `emit_plan`.
- Use `think` to reason about every decision.
- Keep questions short and friendly.
- When the user provides a wallet address, always call `query_onchain` to verify it.
"""


# ─── CopilotPlannerAgent ──────────────────────────────────────────────────────

class CopilotPlannerAgent:
    def __init__(self, llm_caller, mcp_base_url: str = "http://127.0.0.1:8001"):
        self._llm = llm_caller
        self.mcp_base_url = mcp_base_url.rstrip("/")
        self._http = httpx.Client(timeout=15.0)

    # ── Public API ─────────────────────────────────────────────────────────────

    def start_session(self, request: str, session_id: str) -> CopilotState:
        state = CopilotState(
            session_id=session_id,
            original_request=request,
            message_history=[{"role": "user", "content": request}],
        )
        return self._run_iteration(state)

    def continue_session(self, state: CopilotState, user_reply: str) -> CopilotState:
        if state.pending_parameter and user_reply.strip():
            state.confirmed_parameters[state.pending_parameter] = user_reply.strip()
            logger.info("Confirmed %s = %.20s", state.pending_parameter, user_reply)

        state.message_history.append({"role": "user", "content": user_reply})
        state.is_waiting_for_user = False
        state.pending_question = None
        state.pending_parameter = None
        state.iteration = 0
        state.hit_max_iterations = False

        return self._run_iteration(state)

    # ── ReAct Loop ─────────────────────────────────────────────────────────────

    def _run_iteration(self, state: CopilotState) -> CopilotState:
        for i in range(REACT_MAX_ITERATIONS):
            state.iteration += 1

            tool_name, tool_args = self._call_llm_with_tools(state)

            if not tool_name:
                logger.warning("[copilot] LLM returned no tool, forcing finish")
                self._force_finish(state)
                break

            logger.info("[copilot] iter=%d/%d tool=%s", i + 1, REACT_MAX_ITERATIONS, tool_name)

            if tool_name == "think":
                self._handle_think(state, tool_args)
                continue

            elif tool_name == "ask_user":
                self._handle_ask_user(state, tool_args)
                break  # pause — wait for user

            elif tool_name == "query_onchain":
                self._handle_query_onchain(state, tool_args)
                continue

            elif tool_name == "emit_plan":
                self._handle_emit_plan(state, tool_args)
                continue

            elif tool_name == "finish":
                self._handle_finish(state, tool_args)
                break

            else:
                logger.warning("[copilot] unknown tool: %s — skipping", tool_name)
                continue

        else:
            # Loop exhausted REACT_MAX_ITERATIONS without breaking
            logger.warning(
                "[copilot] session=%s hit max iterations (%d), synthesising finish",
                state.session_id,
                REACT_MAX_ITERATIONS,
            )
            state.hit_max_iterations = True
            self._force_finish(state)

        return state

    # ── Tool handlers ──────────────────────────────────────────────────────────

    def _handle_think(self, state: CopilotState, args: Dict[str, Any]) -> None:
        step = CopilotStep(step_type="think", tool_name="think", tool_args=args)
        state.steps.append(step)
        reasoning = args.get("reasoning", "")
        next_action = args.get("next_action", "")
        state.message_history.append({
            "role": "assistant",
            "content": f"[thinking] {reasoning[:300]} → next: {next_action}",
        })

    def _handle_ask_user(self, state: CopilotState, args: Dict[str, Any]) -> None:
        step = CopilotStep(step_type="ask_user", tool_name="ask_user", tool_args=args)
        state.steps.append(step)
        state.is_waiting_for_user = True
        state.pending_question = args.get("question", "")
        state.pending_parameter = args.get("parameter_name", "")
        state.message_history.append({
            "role": "assistant",
            "content": f"[ask_user:{state.pending_parameter}] {state.pending_question}",
        })

    def _handle_query_onchain(self, state: CopilotState, args: Dict[str, Any]) -> None:
        result = self._execute_query_onchain(args)
        step = CopilotStep(
            step_type="query_onchain",
            tool_name="query_onchain",
            tool_args=args,
            result=result,
        )
        state.steps.append(step)
        summary = self._summarize_onchain_result(args, result)
        state.message_history.append({"role": "assistant", "content": f"[query_onchain] {summary}"})
        self._absorb_onchain_result(state, args, result)

    def _handle_emit_plan(self, state: CopilotState, args: Dict[str, Any]) -> None:
        step = CopilotStep(step_type="emit_plan", tool_name="emit_plan", tool_args=args)
        state.steps.append(step)
        state.plan_emitted = True
        state.strategy = args.get("strategy") or state.strategy or "custom_utility"
        params = args.get("confirmed_parameters", {})
        state.confirmed_parameters.update({k: str(v) for k, v in params.items()})
        state.message_history.append({
            "role": "assistant",
            "content": f"[plan] Strategy={state.strategy} params={list(params.keys())}",
        })

    def _handle_finish(self, state: CopilotState, args: Dict[str, Any]) -> None:
        step = CopilotStep(step_type="finish", tool_name="finish", tool_args=args)
        state.steps.append(step)
        state.is_complete = True
        state.final_enriched_prompt = args.get("enriched_prompt", state.original_request)
        state.strategy = args.get("strategy") or state.strategy or "custom_utility"
        params = args.get("confirmed_parameters", {})
        state.confirmed_parameters.update({k: str(v) for k, v in params.items()})

    def _force_finish(self, state: CopilotState) -> None:
        """Synthesise a finish step when the loop exhausts max iterations."""
        enriched = (
            f"{state.original_request}\n\n"
            f"Confirmed parameters: {json.dumps(state.confirmed_parameters)}\n"
            f"Strategy: {state.strategy or 'custom_utility'}"
        )
        synthetic_args = {
            "enriched_prompt": enriched,
            "strategy": state.strategy or "custom_utility",
            "confirmed_parameters": state.confirmed_parameters,
        }
        self._handle_finish(state, synthetic_args)

    # ── LLM call ───────────────────────────────────────────────────────────────

    def _call_llm_with_tools(self, state: CopilotState) -> Tuple[str, Dict[str, Any]]:
        context_parts = [
            f"Session context:",
            f"- Original request: {state.original_request}",
            f"- Confirmed parameters: {json.dumps(state.confirmed_parameters, indent=2)}",
            f"- Strategy: {state.strategy or 'not yet determined'}",
            f"- Plan emitted: {state.plan_emitted}",
            f"- Iteration: {state.iteration}/{REACT_MAX_ITERATIONS}",
        ]

        if state.iteration >= REACT_MAX_ITERATIONS - 2:
            context_parts.append(
                f"\n⚠️  CRITICAL: Only {REACT_MAX_ITERATIONS - state.iteration} iterations left. "
                "You MUST call emit_plan then finish NOW if you have enough info, "
                "or ask_user for the single most critical missing piece."
            )

        recent = state.message_history[-10:]
        history_text = "\n".join(
            f"[{m['role'].upper()}]: {m['content'][:500]}" for m in recent
        )
        context_parts.append(f"\nConversation:\n{history_text}")

        tool_schemas = "\n".join(
            f'- {t["name"]}: {t["description"][:180]}' for t in COPILOT_TOOLS
        )
        context_parts.append(
            f"\n\nAvailable tools:\n{tool_schemas}"
            '\n\nRespond with EXACTLY one JSON object:\n'
            '{"tool": "<name>", "args": {<parameters>}}\n'
            "No markdown, no explanation — raw JSON only."
        )

        user_msg = "\n".join(context_parts)

        try:
            raw = self._llm(
                COPILOT_SYSTEM,
                user_msg,
                temperature=0.0,
                max_tokens=900,
                operation="copilot_react",
            )
        except Exception as exc:
            logger.error("[copilot] LLM call failed: %s", exc)
            return "finish", {
                "enriched_prompt": state.original_request,
                "strategy": state.strategy or "custom_utility",
                "confirmed_parameters": state.confirmed_parameters,
            }

        return self._parse_tool_call(raw)

    def _parse_tool_call(self, raw: str) -> Tuple[str, Dict[str, Any]]:
        raw = raw.strip()
        # Strip markdown code fences
        raw = re.sub(r"```(?:json)?\s*|\s*```", "", raw).strip()

        # Extract outermost JSON object
        start, end = raw.find("{"), raw.rfind("}")
        if start != -1 and end != -1:
            raw = raw[start : end + 1]

        data: Dict[str, Any] = {}
        try:
            data = json.loads(raw)
        except json.JSONDecodeError:
            try:
                from json_repair import loads as repair  # type: ignore
                repaired = repair(raw, return_dict=True)
                if isinstance(repaired, dict):
                    data = repaired
            except Exception:
                pass

        if not data:
            # Last-resort: regex for tool name
            m = re.search(r'"tool"\s*:\s*"([^"]+)"', raw)
            if m:
                return m.group(1), {}
            return "think", {"reasoning": "parse error", "next_action": "finish"}

        tool = str(data.get("tool") or data.get("name") or "think")
        args = data.get("args") or data.get("arguments") or data.get("parameters") or {}
        if not isinstance(args, dict):
            args = {}

        return tool, args

    # ── MCP execution ──────────────────────────────────────────────────────────

    def _execute_query_onchain(self, tool_args: Dict[str, Any]) -> Dict[str, Any]:
        tool = str(tool_args.get("tool", "get_balance"))
        payload = dict(tool_args.get("payload", {}))
        endpoint_map = {
            "get_balance":       "/solana/get_balance",
            "get_token_balance": "/solana/get_token_balance",
            "get_account_info":  "/solana/get_account_info",
            "resolve_sns":       "/solana/resolve_sns",
        }
        path = endpoint_map.get(tool, "/solana/get_balance")
        url = f"{self.mcp_base_url}{path}"
        payload.setdefault("network", "mainnet-beta")

        try:
            resp = self._http.post(url, json=payload, timeout=10.0)
            resp.raise_for_status()
            return resp.json()
        except httpx.RequestError as exc:
            logger.warning("[copilot] MCP unreachable: %s", exc)
            return {"ok": False, "error": f"MCP unreachable: {exc}", "simulated": True}
        except httpx.HTTPStatusError as exc:
            return {"ok": False, "error": f"MCP HTTP {exc.response.status_code}", "simulated": True}
        except Exception as exc:
            return {"ok": False, "error": str(exc), "simulated": True}

    def _summarize_onchain_result(self, tool_args: Dict[str, Any], result: Dict[str, Any]) -> str:
        tool = tool_args.get("tool", "")
        purpose = tool_args.get("purpose", "verification")

        if not result.get("ok", True) and result.get("simulated"):
            return f"[{purpose}] MCP unreachable — treating as valid (simulation mode)"

        if tool == "get_balance":
            lamports = result.get("lamports", 0)
            sol = lamports / 1e9
            addr = tool_args.get("payload", {}).get("address", "?")
            return f"[{purpose}] Wallet {addr[:8]}… {sol:.4f} SOL"

        if tool == "get_account_info":
            exists = result.get("exists", False)
            addr = tool_args.get("payload", {}).get("address", "?")
            return f"[{purpose}] Account {addr[:8]}… exists={exists}"

        if tool == "resolve_sns":
            name = tool_args.get("payload", {}).get("name", "?")
            addr = result.get("address", "unresolved")
            return f"[{purpose}] SNS {name} → {addr}"

        return f"[{purpose}] {json.dumps(result)[:200]}"

    def _absorb_onchain_result(
        self,
        state: CopilotState,
        tool_args: Dict[str, Any],
        result: Dict[str, Any],
    ) -> None:
        tool = tool_args.get("tool", "")
        payload = tool_args.get("payload", {})

        if tool == "get_balance" and result.get("ok", True):
            addr = payload.get("address", "")
            if addr:
                state.confirmed_parameters.setdefault("USER_WALLET_ADDRESS", addr)

        if tool == "resolve_sns" and result.get("address"):
            resolved = result["address"]
            if not resolved.startswith("SNS_"):
                state.confirmed_parameters["USER_WALLET_ADDRESS"] = resolved

        if tool == "get_account_info" and result.get("exists"):
            addr = payload.get("address", "")
            if addr:
                state.confirmed_parameters.setdefault("TOKEN_MINT_ADDRESS", addr)


# ─── Yield sweeper helper (unchanged from v1) ─────────────────────────────────

def build_yield_sweeper_enriched_prompt(params: Dict[str, str]) -> str:
    wallet    = params.get("USER_WALLET_ADDRESS", "")
    threshold = params.get("REBALANCE_THRESHOLD_PCT", "1.5")
    poll_ms   = params.get("POLL_INTERVAL_MS", "60000")
    network   = params.get("SOLANA_NETWORK", "mainnet-beta")
    sim_mode  = params.get("SIMULATION_MODE", "true")

    return f"""
Build a production Solana yield sweeper bot that automatically rebalances USDC between
Kamino Finance and sUSDe (via Jupiter swaps) based on APY comparison.

STRATEGY: yield_sweeper (Kamino USDC ↔ sUSDe via Jupiter)

EXACT TOKEN MINTS — hardcoded, NEVER guessed:
  USDC:   EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v  (6 decimals)
  sUSDe:  G9W2WBKV3nJULX4kz47HCJ75jnVG4RYWZj5q5U5kXfz   (18 decimals)
  SOL:    So11111111111111111111111111111111111111112      (9 decimals)

CONFIRMED PARAMETERS:
  USER_WALLET_ADDRESS = {wallet}
  SOLANA_NETWORK = {network}
  REBALANCE_THRESHOLD_PCT = {threshold}
  POLL_INTERVAL_MS = {poll_ms}
  SIMULATION_MODE = {sim_mode}

EXECUTION RULES:
1. Poll every {poll_ms}ms using setInterval.
2. Fetch Kamino APY: GET https://api.kamino.finance/v1/kamino-market/USDC/reserves
3. Fetch sUSDe APY: GET https://api.ethena.fi/apy — parse .apy field
4. REBALANCE when: |sUSDe_apy - kamino_apy| >= {threshold}% (enter whichever is higher)
5. All swaps via: callMcpTool("jupiter", "execute_swap", {{inputMint, outputMint, amount, userWallet, slippageBps: 50}})
6. Use BigInt for ALL token amounts. USDC=6 decimals, sUSDe=18 decimals.
7. Guard with inFlight boolean to prevent overlapping cycles.
8. Handle SIGINT/SIGTERM gracefully (clearInterval + log).
9. SIMULATION_MODE=true by default — log what would happen, don't execute.
10. Load .env correctly using explicit path resolution with fileURLToPath.
11. Log environment variables at startup for debugging.

OUTPUT FILES (generate exactly these 3 files):
1. package.json — with "type": "module", tsx dev dep, axios, dotenv
2. tsconfig.json — target ES2020, module ES2020, include src/**/*
3. src/index.ts — complete bot logic

Import mcp_bridge.ts and sns_resolver.ts — they are injected automatically.
""".strip()


# ─── FastAPI router ──────────────────────────────────────────────────────────

router = APIRouter(prefix="/copilot", tags=["copilot"])


def _get_meta_agent():
    from orchestrator import MetaAgent

    return MetaAgent()


@router.get("/health")
async def copilot_health() -> Dict[str, Any]:
    return {"status": "ok", "router": "mounted"}


@router.post("/start")
async def copilot_start(body: Dict[str, Any]) -> Dict[str, Any]:
    prompt = str(body.get("prompt", "")).strip()
    if not prompt:
        raise HTTPException(status_code=400, detail="prompt is required")

    session_id = str(body.get("session_id") or body.get("request_id") or f"copilot-{int(time.time())}")
    trace_id = str(body.get("trace_id") or "") or None

    agent = _get_meta_agent()
    result = await agent.build_bot_copilot_start(prompt=prompt, session_id=session_id, trace_id=trace_id)

    try:
        from session_store import save_session

        state = result.get("session_state")
        if isinstance(state, dict):
            save_session(session_id, state)
    except Exception:
        pass

    return result


@router.post("/continue")
async def copilot_continue(body: Dict[str, Any]) -> Dict[str, Any]:
    session_state = body.get("session_state")
    user_reply = str(body.get("user_reply", "")).strip()
    if not isinstance(session_state, dict):
        raise HTTPException(status_code=400, detail="session_state must be an object")
    if not user_reply:
        raise HTTPException(status_code=400, detail="user_reply is required")

    trace_id = str(body.get("trace_id") or "") or None
    agent = _get_meta_agent()
    result = await agent.build_bot_copilot_continue(session_state=session_state, user_reply=user_reply, trace_id=trace_id)

    try:
        from session_store import save_session

        state = result.get("session_state")
        session_id = str(session_state.get("session_id") or "").strip()
        if session_id and isinstance(state, dict):
            save_session(session_id, state)
    except Exception:
        pass

    return result


@router.get("/status/{session_id}")
async def copilot_status(session_id: str) -> Dict[str, Any]:
    try:
        from session_store import load_session, session_exists

        state = load_session(session_id)
        return {
            "status": "ok",
            "session_id": session_id,
            "exists": session_exists(session_id),
            "session_state": state,
        }
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc