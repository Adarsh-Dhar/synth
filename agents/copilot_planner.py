"""
agents/copilot_planner.py

Copilot-style ReAct (Reason + Act) Planning Agent.

Architecture mirrors VS Code Copilot / GitHub Copilot Chat:
  1. User sends a message
  2. Agent REASONS about what it knows vs. what it needs
  3. Agent ACTs by either:
     a. Calling a tool (ask_user, query_mcp, search_docs)
     b. Emitting a plan step
     c. Generating final code (finish)
  4. Loop continues until `finish` is called or max iterations reached

The orchestrator drives the loop; the agent never writes code until
all required parameters are confirmed.
"""

from __future__ import annotations

import json
import logging
import os
import re
import time
from typing import Any, Dict, List, Optional, Tuple

import httpx
from pydantic import BaseModel, Field

logger = logging.getLogger(__name__)

# ─── Configuration ────────────────────────────────────────────────────────────

REACT_MAX_ITERATIONS = int(os.environ.get("REACT_MAX_ITERATIONS", "8"))
REACT_LLM_TIMEOUT    = int(os.environ.get("REACT_LLM_TIMEOUT_SECONDS", "60"))
REACT_MODEL          = os.environ.get("REACT_MODEL_NAME", "gpt-4o-mini")

# ─── Tool Definitions (JSON Schema — fed to LLM as function specs) ────────────

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
                "reasoning": {
                    "type": "string",
                    "description": "Your step-by-step internal reasoning about the current state."
                },
                "have": {
                    "type": "array",
                    "items": {"type": "string"},
                    "description": "List of parameters/context you already have confirmed."
                },
                "need": {
                    "type": "array",
                    "items": {"type": "string"},
                    "description": "List of parameters/context still missing or unverified."
                },
                "next_action": {
                    "type": "string",
                    "enum": ["ask_user", "query_onchain", "search_docs", "emit_plan", "finish"],
                    "description": "What tool you will call next."
                }
            },
            "required": ["reasoning", "next_action"]
        }
    },
    {
        "name": "ask_user",
        "description": (
            "Pause execution and ask the user a clarifying question. "
            "Use this when a REQUIRED parameter is missing (wallet address, token mint, "
            "strategy threshold, etc.). Ask ONE focused question at a time. "
            "Do NOT ask for optional parameters — use sensible defaults instead."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "question": {
                    "type": "string",
                    "description": "The single, focused question to ask the user."
                },
                "parameter_name": {
                    "type": "string",
                    "description": "The env var or parameter name this question resolves (e.g. USER_WALLET_ADDRESS)."
                },
                "examples": {
                    "type": "array",
                    "items": {"type": "string"},
                    "description": "2-3 example valid values to help the user answer."
                },
                "optional": {
                    "type": "boolean",
                    "description": "True if this parameter has a sensible default and isn't strictly required."
                }
            },
            "required": ["question", "parameter_name"]
        }
    },
    {
        "name": "query_onchain",
        "description": (
            "Query the Solana MCP server to verify on-chain data. "
            "Use this to verify wallet addresses exist, check token mint accounts, "
            "resolve SNS domains, or check balances. Always verify addresses before "
            "embedding them in generated code."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "tool": {
                    "type": "string",
                    "enum": ["get_balance", "get_token_balance", "get_account_info", "resolve_sns"],
                    "description": "Which MCP tool to call."
                },
                "payload": {
                    "type": "object",
                    "description": "The arguments to pass to the MCP tool.",
                    "properties": {
                        "network": {"type": "string"},
                        "address": {"type": "string"},
                        "owner": {"type": "string"},
                        "mint": {"type": "string"},
                        "name": {"type": "string"}
                    }
                },
                "purpose": {
                    "type": "string",
                    "description": "Why you are making this query (for logging)."
                }
            },
            "required": ["tool", "payload", "purpose"]
        }
    },
    {
        "name": "emit_plan",
        "description": (
            "Emit a structured plan showing what the bot will do before writing any code. "
            "Call this ONCE after you have all required parameters confirmed. "
            "The plan is shown to the user as a 'thinking' preview (like Copilot's plan step)."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "strategy": {"type": "string", "description": "The detected strategy type."},
                "bot_name": {"type": "string", "description": "Human-readable bot name."},
                "network": {"type": "string"},
                "confirmed_parameters": {
                    "type": "object",
                    "description": "Key-value map of all confirmed env vars and their values."
                },
                "architecture": {
                    "type": "array",
                    "items": {"type": "string"},
                    "description": "Bullet-point architecture decisions (what files, what APIs, etc.)."
                },
                "files_to_generate": {
                    "type": "array",
                    "items": {"type": "string"},
                    "description": "List of file paths that will be generated."
                }
            },
            "required": ["strategy", "bot_name", "network", "confirmed_parameters", "architecture"]
        }
    },
    {
        "name": "finish",
        "description": (
            "Signal that you are ready to generate the final TypeScript code. "
            "Only call this after emit_plan has been called and all parameters are confirmed. "
            "The orchestrator will then call the code generator with the enriched context."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "enriched_prompt": {
                    "type": "string",
                    "description": "The complete, parameter-enriched prompt to send to the code generator."
                },
                "strategy": {"type": "string"},
                "confirmed_parameters": {
                    "type": "object",
                    "description": "Final map of all confirmed env vars."
                }
            },
            "required": ["enriched_prompt", "strategy", "confirmed_parameters"]
        }
    }
]


# ─── Pydantic models ──────────────────────────────────────────────────────────

class CopilotStep(BaseModel):
    """A single step in the ReAct loop."""
    step_type: str  # think | ask_user | query_onchain | emit_plan | finish | error
    tool_name: str
    tool_args: Dict[str, Any] = Field(default_factory=dict)
    result: Optional[Dict[str, Any]] = None
    timestamp: float = Field(default_factory=time.time)


class CopilotState(BaseModel):
    """Full state of a copilot planning session."""
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


# ─── Copilot System Prompt ────────────────────────────────────────────────────

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
- USDC mint is ALWAYS: EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v (never ask)
- sUSDe mint is ALWAYS: G9W2WBKV3nJULX4kz47HCJ75jnVG4RYWZj5q5U5kXfz (never ask)
- SOL mint is ALWAYS: So11111111111111111111111111111111111111112 (never ask)
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
    """
    ReAct loop agent that reasons, asks questions, and plans before generating code.
    Mirrors GitHub Copilot's planning behaviour.
    """

    def __init__(self, llm_caller, mcp_base_url: str = "http://127.0.0.1:8001"):
        self._llm = llm_caller
        self.mcp_base_url = mcp_base_url.rstrip("/")
        self._http = httpx.Client(timeout=15.0)

    # ── Public API ─────────────────────────────────────────────────────────────

    def start_session(self, request: str, session_id: str) -> CopilotState:
        """Create a new copilot session and run the first iteration."""
        state = CopilotState(
            session_id=session_id,
            original_request=request,
            message_history=[{"role": "user", "content": request}],
        )
        return self._run_iteration(state)

    def continue_session(self, state: CopilotState, user_reply: str) -> CopilotState:
        """Continue a session after the user answers a clarifying question."""
        # Record the answer as a parameter if we know which one
        if state.pending_parameter and user_reply.strip():
            value = user_reply.strip()
            state.confirmed_parameters[state.pending_parameter] = value
            logger.info("Confirmed %s = %s", state.pending_parameter, value[:20])

        # Append to history
        state.message_history.append({"role": "user", "content": user_reply})
        state.is_waiting_for_user = False
        state.pending_question = None
        state.pending_parameter = None
        state.iteration = 0  # reset iteration count for new sub-loop

        return self._run_iteration(state)

    # ── ReAct Loop ─────────────────────────────────────────────────────────────

    def _run_iteration(self, state: CopilotState) -> CopilotState:
        """Run the ReAct loop until we need user input or are done."""
        for _ in range(REACT_MAX_ITERATIONS):
            state.iteration += 1

            # Build the prompt with full history
            tool_name, tool_args = self._call_llm_with_tools(state)
            if not tool_name:
                break

            logger.info("[copilot] iteration=%d tool=%s", state.iteration, tool_name)

            # Dispatch tool
            if tool_name == "think":
                step = CopilotStep(step_type="think", tool_name="think", tool_args=tool_args)
                state.steps.append(step)
                # Append think result to history so next call has it
                state.message_history.append({
                    "role": "assistant",
                    "content": f"[thinking] {tool_args.get('reasoning', '')} → next: {tool_args.get('next_action', '')}"
                })
                continue

            elif tool_name == "ask_user":
                step = CopilotStep(step_type="ask_user", tool_name="ask_user", tool_args=tool_args)
                state.steps.append(step)
                state.is_waiting_for_user = True
                state.pending_question = tool_args.get("question", "")
                state.pending_parameter = tool_args.get("parameter_name", "")
                state.message_history.append({
                    "role": "assistant",
                    "content": f"[ask_user:{state.pending_parameter}] {state.pending_question}"
                })
                break  # Pause loop — wait for user

            elif tool_name == "query_onchain":
                result = self._execute_query_onchain(tool_args)
                step = CopilotStep(
                    step_type="query_onchain",
                    tool_name="query_onchain",
                    tool_args=tool_args,
                    result=result
                )
                state.steps.append(step)
                summary = self._summarize_onchain_result(tool_args, result)
                state.message_history.append({
                    "role": "assistant",
                    "content": f"[query_onchain] {summary}"
                })
                # Absorb verified addresses into confirmed params
                self._absorb_onchain_result(state, tool_args, result)
                continue

            elif tool_name == "emit_plan":
                step = CopilotStep(step_type="emit_plan", tool_name="emit_plan", tool_args=tool_args)
                state.steps.append(step)
                state.plan_emitted = True
                state.strategy = tool_args.get("strategy", "custom_utility")
                # Merge confirmed params from plan
                params = tool_args.get("confirmed_parameters", {})
                state.confirmed_parameters.update({k: str(v) for k, v in params.items()})
                state.message_history.append({
                    "role": "assistant",
                    "content": f"[plan] Strategy={state.strategy} params={list(params.keys())}"
                })
                continue

            elif tool_name == "finish":
                step = CopilotStep(step_type="finish", tool_name="finish", tool_args=tool_args)
                state.steps.append(step)
                state.is_complete = True
                state.final_enriched_prompt = tool_args.get("enriched_prompt", state.original_request)
                state.strategy = tool_args.get("strategy", state.strategy or "custom_utility")
                # Final param merge
                params = tool_args.get("confirmed_parameters", {})
                state.confirmed_parameters.update({k: str(v) for k, v in params.items()})
                break

            else:
                logger.warning("[copilot] unknown tool: %s", tool_name)
                break

        return state

    # ── LLM Call with Tool Parsing ──────────────────────────────────────────────

    def _call_llm_with_tools(self, state: CopilotState) -> Tuple[str, Dict[str, Any]]:
        """Call the LLM and parse which tool it wants to call."""
        # Build user message with full context
        context_parts = [
            f"Session context:\n- Original request: {state.original_request}",
            f"- Confirmed parameters so far: {json.dumps(state.confirmed_parameters, indent=2)}",
            f"- Strategy detected: {state.strategy or 'not yet determined'}",
            f"- Plan emitted: {state.plan_emitted}",
            f"- Iteration: {state.iteration}",
        ]

        recent_history = state.message_history[-8:]  # last 8 messages
        history_text = "\n".join(
            f"[{m['role'].upper()}]: {m['content'][:400]}"
            for m in recent_history
        )

        context_parts.append(f"\nConversation so far:\n{history_text}")

        tools_instruction = (
            "\n\nAvailable tools (respond with EXACTLY one JSON tool call):\n"
            + json.dumps([{"name": t["name"], "description": t["description"][:200]} for t in COPILOT_TOOLS], indent=2)
            + "\n\nRespond with a JSON object like:\n"
            + '{"tool": "think", "args": {"reasoning": "...", "next_action": "ask_user"}}'
            + "\n\nOnly output the JSON — no markdown, no explanation."
        )

        system = COPILOT_SYSTEM
        user = "\n".join(context_parts) + tools_instruction

        try:
            raw = self._llm(
                system, user,
                temperature=0.0,
                max_tokens=800,
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
        """Parse the LLM's tool call JSON response."""
        raw = raw.strip()
        # Strip markdown fences
        raw = re.sub(r"```(?:json)?\s*|\s*```", "", raw).strip()
        # Find first JSON object
        start, end = raw.find("{"), raw.rfind("}")
        if start != -1 and end != -1:
            raw = raw[start:end + 1]

        try:
            data = json.loads(raw)
        except json.JSONDecodeError:
            try:
                from json_repair import loads as repair  # type: ignore
                data = repair(raw, return_dict=True)
            except Exception:
                data = {}

        tool = str(data.get("tool", data.get("name", "think")))
        args = data.get("args", data.get("arguments", data.get("parameters", {})))
        if not isinstance(args, dict):
            args = {}

        # Handle nested tool call format {"tool": "ask_user", "args": {...}}
        return tool, args

    # ── MCP Query Execution ────────────────────────────────────────────────────

    def _execute_query_onchain(self, tool_args: Dict[str, Any]) -> Dict[str, Any]:
        """Execute an on-chain MCP query."""
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

        # Ensure network is set
        payload.setdefault("network", "mainnet-beta")

        try:
            resp = self._http.post(url, json=payload, timeout=10.0)
            resp.raise_for_status()
            return resp.json()
        except httpx.RequestError as exc:
            return {"ok": False, "error": f"MCP unreachable: {exc}", "simulated": True}
        except httpx.HTTPStatusError as exc:
            return {"ok": False, "error": f"MCP HTTP {exc.response.status_code}", "simulated": True}
        except Exception as exc:
            return {"ok": False, "error": str(exc), "simulated": True}

    def _summarize_onchain_result(self, tool_args: Dict[str, Any], result: Dict[str, Any]) -> str:
        """Create a human-readable summary of an on-chain query result."""
        tool = tool_args.get("tool", "")
        purpose = tool_args.get("purpose", "verification")

        if not result.get("ok", True) and result.get("simulated"):
            return f"[{purpose}] MCP server unreachable — treating as valid (simulation mode)"

        if tool == "get_balance":
            lamports = result.get("lamports", 0)
            sol = lamports / 1e9
            addr = result.get("address", "?")
            return f"[{purpose}] Wallet {addr[:8]}... has {sol:.4f} SOL ({lamports} lamports)"

        if tool == "get_account_info":
            exists = result.get("exists", False)
            addr = tool_args.get("payload", {}).get("address", "?")
            return f"[{purpose}] Account {addr[:8]}... exists={exists}"

        if tool == "resolve_sns":
            name = tool_args.get("payload", {}).get("name", "?")
            addr = result.get("address", "unresolved")
            return f"[{purpose}] SNS {name} → {addr}"

        return f"[{purpose}] result={json.dumps(result)[:200]}"

    def _absorb_onchain_result(
        self,
        state: CopilotState,
        tool_args: Dict[str, Any],
        result: Dict[str, Any],
    ) -> None:
        """Store verified addresses into confirmed_parameters."""
        tool = tool_args.get("tool", "")
        payload = tool_args.get("payload", {})

        if tool == "get_balance" and result.get("ok", True):
            addr = payload.get("address", "")
            if addr:
                state.confirmed_parameters.setdefault("USER_WALLET_ADDRESS", addr)

        if tool == "resolve_sns" and result.get("address"):
            resolved = result["address"]
            if not resolved.startswith("SNS_"):  # not a simulation placeholder
                state.confirmed_parameters["USER_WALLET_ADDRESS"] = resolved

        if tool == "get_account_info" and result.get("exists"):
            addr = payload.get("address", "")
            if addr:
                state.confirmed_parameters.setdefault("TOKEN_MINT_ADDRESS", addr)


# ─── Helper: build yield sweeper enriched prompt ──────────────────────────────

def build_yield_sweeper_enriched_prompt(params: Dict[str, str]) -> str:
    """Build the final enriched prompt for the Kamino/sUSDe yield sweeper."""
    wallet = params.get("USER_WALLET_ADDRESS", "")
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