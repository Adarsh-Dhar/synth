"""
agents/planner.py

Planner Agent — Phase 1 & 2 of the Planner Agent architecture.

Defines Pydantic schemas for structured LLM output and the PlannerAgent
class that drives the Understand → Investigate (MCP) → Validate → Interact
→ Execute pipeline.

The Planner uses the Solana MCP server as an on-chain oracle BEFORE
any code is generated, resolving addresses, verifying pool existence,
and confirming token decimals so the Code Generator receives a fully
verified, enriched plan.
"""

from __future__ import annotations

import json
import logging
import os
import re
import time
from typing import Any, Dict, List, Optional

import httpx
from pydantic import BaseModel, Field

logger = logging.getLogger(__name__)

# ─── MCP Server config ────────────────────────────────────────────────────────

SOLANA_MCP_BASE = os.environ.get("SOLANA_MCP_URL", "http://127.0.0.1:8001")
MCP_TIMEOUT     = float(os.environ.get("SOLANA_MCP_TIMEOUT_SECONDS", "10"))
PLANNER_HISTORY_MAX_TURNS = int(os.environ.get("PLANNER_HISTORY_MAX_TURNS", "6"))
PLANNER_HISTORY_MAX_CHARS = int(os.environ.get("PLANNER_HISTORY_MAX_CHARS", "2800"))


# ─── Pydantic Schemas ─────────────────────────────────────────────────────────

class OnChainVerification(BaseModel):
    needs_mcp_query: bool = Field(
        description=(
            "True when the planner must verify an on-chain value before code generation. "
            "Examples: resolving an SNS (.sol) name, checking a pool address exists, "
            "fetching token decimal precision."
        )
    )
    mcp_tool_name: Optional[str] = Field(
        default=None,
        description="MCP tool to call. Examples: 'move_view', 'get_balance', 'get_token_balance'.",
    )
    mcp_payload: Optional[Dict[str, Any]] = Field(
        default=None,
        description=(
            "Exact payload to POST to the MCP gateway. For Solana this may include: network, address, programId, instruction, accounts, args."
        ),
    )
    verification_purpose: Optional[str] = Field(
        default=None,
        description="Human-readable reason for the MCP query (for logging).",
    )


class PlannerState(BaseModel):
    strategy_type: str = Field(
        description=(
            "Detected strategy: 'yield_sweeper', 'arbitrage', 'spread_scanner', "
            "'cross_chain_liquidation', 'cross_chain_arbitrage', 'cross_chain_sweep', "
            "'sentiment', 'custom_utility', 'unknown'."
        )
    )
    collected_parameters: Dict[str, str] = Field(
        default_factory=dict,
        description=(
            "All confirmed runtime variables gathered so far. "
            "Keys match bot .env variable names (e.g. 'SOLANA_POOL_A_ADDRESS')."
        ),
    )
    missing_parameters: List[str] = Field(
        default_factory=list,
        description=(
            "Variable names that are still required but have not been provided "
            "or verified yet."
        ),
    )
    verification_step: Optional[OnChainVerification] = Field(
        default=None,
        description="On-chain verification action to perform next, if any.",
    )
    is_ready_for_code_generation: bool = Field(
        description=(
            "True when all required parameters are collected and verified "
            "and the code generator can be invoked."
        )
    )
    clarifying_question_for_user: Optional[str] = Field(
        default=None,
        description=(
            "A single focused question to ask the user when a required parameter "
            "is missing and cannot be resolved via MCP."
        ),
    )
    enriched_prompt: Optional[str] = Field(
        default=None,
        description=(
            "Final prompt string to pass to the Code Generator, enriched with "
            "all verified on-chain data injected inline."
        ),
    )
    # Internal diagnostic fields
    mcp_results_summary: Optional[str] = Field(
        default=None,
        description="Condensed summary of MCP results injected into context.",
    )


# ─── Planner System Prompt ────────────────────────────────────────────────────

PLANNER_SYSTEM = """\
You are the Planner Agent for Agentia, a Solana-native DeFi bot platform.

Your job is to analyse the conversation history and decide what to do NEXT.
You ALWAYS respond with a single valid JSON object matching this exact schema — no markdown, no preamble:

{
  "strategy_type": "<string>",
  "collected_parameters": { "<ENV_KEY>": "<value>", ... },
  "missing_parameters": ["<ENV_KEY>", ...],
  "verification_step": {
     "needs_mcp_query": true | false,
     "mcp_tool_name": "move_view" | "get_balance" | "get_token_balance" | null,
     "mcp_payload": { ... } | null,
     "verification_purpose": "<string>" | null
  } | null,
  "is_ready_for_code_generation": true | false,
  "clarifying_question_for_user": "<string>" | null,
  "enriched_prompt": "<string>" | null,
  "mcp_results_summary": null
}

STRATEGY DETECTION:
- yield / sweep / consolidate / bridge-back → "yield_sweeper"
- arbitrage / flash-loan / spatial / spread-scanner → "arbitrage"
- cross-chain liquidation / liquidation-sniper → "cross_chain_liquidation"
- cross-chain arb / flash-bridge → "cross_chain_arbitrage"
- yield-nomad / auto-compounder / omni-chain-yield → "cross_chain_sweep"
- sentiment / social / news → "sentiment"
- anything else custom → "custom_utility"

PARAMETER REQUIREMENTS by strategy:
- yield_sweeper:      USER_WALLET_ADDRESS, SOLANA_BRIDGE_ADDRESS, SOLANA_USDC_METADATA_ADDRESS
- arbitrage:          SOLANA_POOL_A_ADDRESS, SOLANA_POOL_B_ADDRESS, SOLANA_SWAP_ROUTER_ADDRESS,
                            SOLANA_USDC_METADATA_ADDRESS, SOLANA_EXECUTION_AMOUNT_USDC
- cross_chain_liquidation:
                            SOLANA_MOCK_ORACLE_ADDRESS, SOLANA_MOCK_LENDING_ADDRESS,
                            SOLANA_LIQUIDATION_WATCHLIST
- cross_chain_arbitrage / cross_chain_sweep:
                            SOLANA_POOL_A_ADDRESS, SOLANA_POOL_B_ADDRESS, SOLANA_BRIDGE_ADDRESS,
                            USER_WALLET_ADDRESS, SOLANA_USDC_METADATA_ADDRESS
- sentiment:          SOLANA_POOL_A_ADDRESS, SOLANA_POOL_B_ADDRESS, USER_WALLET_ADDRESS
- custom_utility:     only what the user explicitly provided

MCP VERIFICATION RULES:
1. If any address ends in ".sol" or appears to be an SNS handle, set needs_mcp_query=true and build an MCP payload suitable for the Solana MCP shim (e.g., mcp_tool_name="move_view" with module="name_service", function="resolve" and args=["<name>.sol"]).
2. If a pool address is provided, verify it by requesting pool info via the MCP shim (module="dex", function="get_pool_info").
3. If token decimals are unknown, query via the MCP shim for token metadata/decimals.
4. Never invent MCP results — only set needs_mcp_query=true and let the orchestrator call MCP.

FLOW:
1. If collected_parameters is missing required keys → set missing_parameters, ask clarifying_question.
2. If any value needs on-chain verification → set verification_step.needs_mcp_query=true.
3. If MCP results have been injected into the conversation → incorporate them into
    collected_parameters and clear the verification_step.
4. If all parameters collected and verified → set is_ready_for_code_generation=true,
    build enriched_prompt with all verified values inline.

NETWORK: set SOLANA_NETWORK to "devnet" for development.
"""


# ─── MCP Client ───────────────────────────────────────────────────────────────

class SolanaMCPClient:
    """Thin synchronous HTTP client for the local Solana MCP server."""

    def __init__(self, base_url: str = SOLANA_MCP_BASE, timeout: float = MCP_TIMEOUT) -> None:
        self.base_url = base_url.rstrip("/")
        self.timeout  = timeout

    def health(self) -> bool:
        try:
            resp = httpx.get(f"{self.base_url}/health", timeout=3.0)
            return resp.status_code == 200
        except Exception:
            return False

    def move_view(self, payload: Dict[str, Any]) -> Dict[str, Any]:
        """
        POST /solana/move_view on the local Solana MCP shim — synchronous, raises on HTTP error.
        Returns the parsed JSON response dict.
        """
        url = f"{self.base_url}/solana/move_view"
        try:
            resp = httpx.post(url, json=payload, timeout=self.timeout)
            resp.raise_for_status()
            return resp.json()
        except httpx.HTTPStatusError as exc:
            raise RuntimeError(
                f"MCP move_view HTTP {exc.response.status_code}: {exc.response.text[:400]}"
            ) from exc
        except httpx.RequestError as exc:
            raise RuntimeError(f"MCP move_view request failed: {exc}") from exc


# ─── PlannerAgent ─────────────────────────────────────────────────────────────

class PlannerAgent:
    """
    Wraps the Planner LLM call and exposes a single plan() method that
    returns a PlannerState instance.
    """

    def __init__(self, llm_caller) -> None:
        """
        Args:
            llm_caller: callable(system: str, user: str, max_tokens: int) -> str
                        Typically MetaAgent._llm with operation kwarg stripped.
        """
        self._llm    = llm_caller
        self.mcp     = SolanaMCPClient()

    # ── Public API ─────────────────────────────────────────────────────────────

    def plan(
        self,
        chat_history: List[Dict[str, str]],
        trace_id: Optional[str] = None,
    ) -> PlannerState:
        """
        Call the Planner LLM with the full chat history and parse the result
        into a validated PlannerState.
        """
        # Serialise history for the user turn
        history_text = self._format_history(chat_history)
        if len(history_text) > PLANNER_HISTORY_MAX_CHARS:
            logger.info(
                "Planner history truncated: %s -> %s chars",
                len(history_text),
                PLANNER_HISTORY_MAX_CHARS,
            )
            history_text = history_text[-PLANNER_HISTORY_MAX_CHARS:]
        raw = self._llm(
            PLANNER_SYSTEM,
            f"Analyse this conversation and return the JSON plan:\n\n{history_text}",
            max_tokens=1024,
            operation="planner",
            trace_id=trace_id,
        )
        return self._parse_plan(raw)

    # ── Helpers ────────────────────────────────────────────────────────────────

    @staticmethod
    def _format_history(history: List[Dict[str, str]]) -> str:
        lines: List[str] = []
        bounded_history = history[-PLANNER_HISTORY_MAX_TURNS:] if PLANNER_HISTORY_MAX_TURNS > 0 else history
        for msg in bounded_history:
            role    = str(msg.get("role", "unknown")).upper()
            content = str(msg.get("content", ""))
            lines.append(f"[{role}]: {content}")
        return "\n".join(lines)

    @staticmethod
    def _parse_plan(raw: str) -> PlannerState:
        # Strip markdown fences
        raw = re.sub(r"```(?:json)?\s*|\s*```", "", raw).strip()
        # Extract outermost JSON object
        start = raw.find("{")
        end   = raw.rfind("}")
        if start != -1 and end != -1:
            raw = raw[start : end + 1]
        # Remove trailing commas
        raw = re.sub(r",\s*([}\]])", r"\1", raw)

        try:
            data = json.loads(raw)
        except json.JSONDecodeError:
            try:
                from json_repair import loads as repair_loads  # type: ignore
                data = repair_loads(raw, return_dict=True)
            except Exception:
                data = {}

        # Provide safe defaults
        data.setdefault("strategy_type", "unknown")
        data.setdefault("collected_parameters", {})
        data.setdefault("missing_parameters", [])
        data.setdefault("is_ready_for_code_generation", False)
        data.setdefault("clarifying_question_for_user", None)
        data.setdefault("enriched_prompt", None)
        data.setdefault("mcp_results_summary", None)
        data.setdefault("verification_step", None)

        # Parse nested verification_step
        vs = data.get("verification_step")
        if vs and isinstance(vs, dict):
            data["verification_step"] = OnChainVerification(**vs)
        else:
            data["verification_step"] = None

        try:
            return PlannerState(**data)
        except Exception as exc:
            logger.warning("PlannerState parse error: %s — returning safe fallback", exc)
            return PlannerState(
                strategy_type="unknown",
                collected_parameters={},
                missing_parameters=[],
                is_ready_for_code_generation=False,
                clarifying_question_for_user=(
                    "Could you give me more details about what your bot should do? "
                    "For example, which pools or tokens should it use?"
                ),
            )


# ─── MCP result extraction helpers ───────────────────────────────────────────

def extract_resolved_address(mcp_response: Dict[str, Any]) -> Optional[str]:
    """Pull a resolved address string out of a move_view MCP response."""
    result = mcp_response.get("result", {})
    if isinstance(result, dict):
        # Standard content array shape
        content = result.get("content", [])
        if isinstance(content, list):
            for item in content:
                text = item.get("text", "") if isinstance(item, dict) else ""
                try:
                    inner = json.loads(text)
                    for field in ("address", "resolved_address", "value"):
                        if isinstance(inner, dict) and inner.get(field):
                            return str(inner[field])
                except (json.JSONDecodeError, AttributeError):
                    text = str(text).strip()
                    # Heuristic: return base58-looking strings as Solana addresses
                    if re.match(r'^[1-9A-HJ-NP-Za-km-z]{32,64}$', text):
                        return text
        # Direct data field
        data = result.get("data")
        if isinstance(data, str):
            trimmed = data.strip()
            if re.match(r'^[1-9A-HJ-NP-Za-km-z]{32,64}$', trimmed):
                return trimmed
    return None


def extract_pool_info(mcp_response: Dict[str, Any]) -> Optional[Dict[str, str]]:
    """Extract coin_a_amount / coin_b_amount from get_pool_info response."""
    result = mcp_response.get("result", {})
    if not isinstance(result, dict):
        return None
    data_raw = result.get("data", "")
    if isinstance(data_raw, str):
        try:
            data = json.loads(data_raw)
            if isinstance(data, dict):
                return {
                    "coin_a_amount": str(data.get("coin_a_amount", "")),
                    "coin_b_amount": str(data.get("coin_b_amount", "")),
                }
        except json.JSONDecodeError:
            pass
    return None


def summarise_mcp_result(
    purpose: str,
    payload: Dict[str, Any],
    response: Dict[str, Any],
) -> str:
    """
    Build a concise human-readable summary to inject back into the chat history
    so the Planner LLM can use the verified data on the next loop iteration.
    """
    lines = [f"MCP Verification Result [{purpose}]:"]
    lines.append(f"  Query: {json.dumps(payload, separators=(',', ':'))}")

    resolved = extract_resolved_address(response)
    pool_info = extract_pool_info(response)

    if resolved:
        lines.append(f"  Resolved address: {resolved}")
    elif pool_info:
        lines.append(f"  Pool coin_a_amount={pool_info['coin_a_amount']} coin_b_amount={pool_info['coin_b_amount']}")
    else:
        lines.append(f"  Raw response: {json.dumps(response, separators=(',', ':'))[:500]}")

    return "\n".join(lines)