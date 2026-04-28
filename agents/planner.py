"""
agents/planner.py

Planner Agent — drives the Understand → Investigate → Validate → Generate pipeline.

Uses the local Solana MCP server as an on-chain oracle before any code is
generated, so the Code Generator receives fully verified parameters.
"""

from __future__ import annotations

import json
import logging
import os
import re
from typing import Any, Dict, List, Optional

import httpx
from pydantic import BaseModel, Field

logger = logging.getLogger(__name__)

SOLANA_MCP_BASE           = os.environ.get("SOLANA_MCP_URL", "http://127.0.0.1:8001")
DODO_MCP_BASE             = os.environ.get("DODO_MCP_URL", "http://127.0.0.1:5002")
MCP_TIMEOUT               = float(os.environ.get("SOLANA_MCP_TIMEOUT_SECONDS", "10"))
PLANNER_HISTORY_MAX_TURNS = int(os.environ.get("PLANNER_HISTORY_MAX_TURNS", "6"))
PLANNER_HISTORY_MAX_CHARS = int(os.environ.get("PLANNER_HISTORY_MAX_CHARS", "3000"))


# ─── Pydantic schemas ─────────────────────────────────────────────────────────

class OnChainVerification(BaseModel):
    needs_mcp_query: bool = Field(
        description="True when the planner must verify an on-chain value before generating code."
    )
    mcp_tool: Optional[str] = Field(
        default=None,
        description="MCP tool name: 'get_balance' | 'get_token_balance' | 'get_account_info' | 'resolve_sns'",
    )
    mcp_payload: Optional[Dict[str, Any]] = Field(
        default=None,
        description="Exact payload to POST to the MCP gateway.",
    )
    verification_purpose: Optional[str] = Field(
        default=None,
        description="Human-readable reason for this query (for logging).",
    )


class PlannerState(BaseModel):
    strategy_type: str = Field(
        description=(
            "Detected strategy: 'yield_sweeper' | 'arbitrage' | 'liquidation' | "
            "'sniping' | 'dca' | 'grid' | 'whale_mirror' | 'sentiment' | "
            "'private_transfer' | 'shielded_yield' | 'metered_execution' | 'custom_utility' | 'unknown'"
        )
    )
    collected_parameters: Dict[str, str] = Field(
        default_factory=dict,
        description="Confirmed runtime env vars, e.g. {'USER_WALLET_ADDRESS': '...'}.",
    )
    missing_parameters: List[str] = Field(
        default_factory=list,
        description="Env var names still required but not yet provided or verified.",
    )
    verification_step: Optional[OnChainVerification] = Field(
        default=None,
        description="On-chain verification to perform next, if any.",
    )
    is_ready_for_code_generation: bool = Field(
        description="True when all required parameters are collected and verified.",
    )
    clarifying_question_for_user: Optional[str] = Field(
        default=None,
        description="Single focused question to ask the user when a required parameter is missing.",
    )
    enriched_prompt: Optional[str] = Field(
        default=None,
        description="Final prompt for the Code Generator with all verified data inline.",
    )
    mcp_results_summary: Optional[str] = Field(
        default=None,
        description="Condensed summary of MCP results (for logging only).",
    )


# ─── Planner system prompt ────────────────────────────────────────────────────

PLANNER_SYSTEM = """\
You are the Planner Agent for Agentia, a Solana-native DeFi bot platform.

Analyse the conversation and return ONLY a single valid JSON object — no markdown, no preamble:

{
  "strategy_type": "<string>",
  "collected_parameters": { "<ENV_KEY>": "<value>", ... },
  "missing_parameters": ["<ENV_KEY>", ...],
  "verification_step": {
    "needs_mcp_query": true | false,
    "mcp_tool": "get_balance" | "get_token_balance" | "get_account_info" | "resolve_sns" | null,
    "mcp_payload": { ... } | null,
    "verification_purpose": "<string>" | null
  } | null,
  "is_ready_for_code_generation": true | false,
  "clarifying_question_for_user": "<string>" | null,
  "enriched_prompt": "<string>" | null,
  "mcp_results_summary": null
}

STRATEGY DETECTION:
  yield / sweep / consolidate            → "yield_sweeper"
    shielded yield / private sweep         → "shielded_yield"
    private transfer / confidential move   → "private_transfer"
    metered / billed execution             → "metered_execution"
  arb / spread / flash                   → "arbitrage"
  liquidation / health-factor            → "liquidation"
  snipe / new-token / launch             → "sniping"
  dca / dollar-cost                      → "dca"
  grid                                   → "grid"
  whale / copy-trade                     → "whale_mirror"
  sentiment / social / news              → "sentiment"
  anything else                          → "custom_utility"

REQUIRED PARAMETERS by strategy:
  yield_sweeper:   USER_WALLET_ADDRESS, TOKEN_MINT_ADDRESS, SOLANA_NETWORK
  arbitrage:       POOL_ADDRESS, TOKEN_MINT_ADDRESS, TRADE_AMOUNT_LAMPORTS,
                   USER_WALLET_ADDRESS, MIN_PROFIT_LAMPORTS
  liquidation:     PROGRAM_ID, USER_WALLET_ADDRESS, SOLANA_LIQUIDATION_WATCHLIST
  sniping:         TOKEN_MINT_ADDRESS, USER_WALLET_ADDRESS, TRADE_AMOUNT_LAMPORTS
  dca:             TOKEN_MINT_ADDRESS, USER_WALLET_ADDRESS, TRADE_AMOUNT_LAMPORTS
  grid:            POOL_ADDRESS, TOKEN_MINT_ADDRESS, USER_WALLET_ADDRESS, TRADE_AMOUNT_LAMPORTS
  whale_mirror:    USER_WALLET_ADDRESS, TOKEN_MINT_ADDRESS
  sentiment:       USER_WALLET_ADDRESS, TOKEN_MINT_ADDRESS
    private_transfer: USER_WALLET_ADDRESS, TOKEN_MINT_ADDRESS, RECIPIENT_ADDRESS,
                                        MAGICBLOCK_PRIVATE_PAYMENTS_BASE_URL
    shielded_yield:  USER_WALLET_ADDRESS, TOKEN_MINT_ADDRESS, UMBRA_PROGRAM_ADDRESS,
                                     UMBRA_NETWORK
    metered_execution: USER_WALLET_ADDRESS, DODO_PLAN_PRO_ID
  custom_utility:  only what the user explicitly provided

MCP VERIFICATION RULES:
1. Wallet address provided → verify with: mcp_tool="get_balance", payload={network, address}
2. Token mint provided → verify with: mcp_tool="get_account_info", payload={network, address: <mint>}
3. .sol domain provided → resolve with: mcp_tool="resolve_sns", payload={network, name: "<domain>.sol"}
4. GoldRush data checks → mcp_tool="goldrush_token_balances" with wallet + network.
5. MagicBlock private transfer checks → mcp_tool="magicblock_transfer" with from/to/mint/amount.
6. Dodo metering/checkout checks → mcp_tool="dodo_metering" or "dodo_checkout" with plan and wallet info.
4. Never invent MCP results — only set needs_mcp_query=true and let the orchestrator call MCP.

FLOW:
1. Missing required params → set missing_parameters + clarifying_question_for_user.
2. Unverified address/mint → set verification_step.needs_mcp_query=true.
3. MCP results injected → absorb into collected_parameters, clear verification_step.
4. All params collected and verified → set is_ready_for_code_generation=true and build enriched_prompt.

NETWORK: always set SOLANA_NETWORK="devnet" unless user says mainnet.
"""


# ─── Solana MCP client ────────────────────────────────────────────────────────

class SolanaMCPClient:
    """Thin synchronous HTTP client for the local Solana MCP server."""

    def __init__(self, base_url: str = SOLANA_MCP_BASE, timeout: float = MCP_TIMEOUT) -> None:
        self.base_url = base_url.rstrip("/")
        self.timeout  = timeout

    def health(self) -> bool:
        try:
            r = httpx.get(f"{self.base_url}/health", timeout=3.0)
            return r.status_code == 200
        except Exception:
            return False

    def query(self, payload: Dict[str, Any]) -> Dict[str, Any]:
        """
        Route a verification payload to the appropriate MCP endpoint.
        The payload must contain a 'mcp_tool' key that maps to an endpoint.
        Falls back to /solana/get_balance for unknown tools.
        """
        tool = str(payload.get("mcp_tool", "get_balance"))
        endpoint_map = {
            "get_balance":       "/solana/get_balance",
            "get_token_balance": "/solana/get_token_balance",
            "get_account_info":  "/solana/get_account_info",
            "resolve_sns":       "/solana/resolve_sns",
            "goldrush_token_balances": "/goldrush/token-balances",
            "goldrush_decoded_events": "/goldrush/decoded-events",
            "magicblock_deposit": "/magicblock/deposit",
            "magicblock_transfer": "/magicblock/transfer",
            "magicblock_withdraw": "/magicblock/withdraw",
            "umbra_shield": "/umbra/shield",
            "umbra_transfer": "/umbra/transfer",
            "dodo_checkout": "/dodo/checkout",
            "dodo_webhook": "/dodo/webhook",
            "dodo_metering": "/dodo/meter",
        }
        path = endpoint_map.get(tool, "/solana/get_balance")
        base_url = DODO_MCP_BASE if tool.startswith("dodo_") else self.base_url
        url  = f"{base_url.rstrip('/')}{path}"

        # Strip internal planner-only fields before forwarding
        fwd = {k: v for k, v in payload.items() if k not in {"mcp_tool", "verification_purpose"}}

        try:
            r = httpx.post(url, json=fwd, timeout=self.timeout)
            r.raise_for_status()
            return r.json()
        except httpx.HTTPStatusError as exc:
            raise RuntimeError(
                f"MCP {tool} HTTP {exc.response.status_code}: {exc.response.text[:400]}"
            ) from exc
        except httpx.RequestError as exc:
            raise RuntimeError(f"MCP {tool} request failed: {exc}") from exc


# ─── PlannerAgent ─────────────────────────────────────────────────────────────

class PlannerAgent:
    def __init__(self, llm_caller) -> None:
        self._llm = llm_caller
        self.mcp  = SolanaMCPClient()

    def plan(
        self,
        chat_history: List[Dict[str, str]],
        trace_id: Optional[str] = None,
    ) -> PlannerState:
        text = self._format_history(chat_history)
        if len(text) > PLANNER_HISTORY_MAX_CHARS:
            text = text[-PLANNER_HISTORY_MAX_CHARS:]

        raw = self._llm(
            PLANNER_SYSTEM,
            f"Analyse this conversation and return the JSON plan:\n\n{text}",
            max_tokens=1024,
            operation="planner",
            trace_id=trace_id,
        )
        return self._parse(raw)

    @staticmethod
    def _format_history(history: List[Dict[str, str]]) -> str:
        bounded = history[-PLANNER_HISTORY_MAX_TURNS:] if PLANNER_HISTORY_MAX_TURNS > 0 else history
        return "\n".join(
            f"[{msg.get('role', 'unknown').upper()}]: {msg.get('content', '')}"
            for msg in bounded
        )

    @staticmethod
    def _parse(raw: str) -> PlannerState:
        raw = re.sub(r"```(?:json)?\s*|\s*```", "", raw).strip()
        s, e = raw.find("{"), raw.rfind("}")
        if s != -1 and e != -1:
            raw = raw[s:e + 1]
        raw = re.sub(r",\s*([}\]])", r"\1", raw)

        try:
            data = json.loads(raw)
        except json.JSONDecodeError:
            try:
                from json_repair import loads as repair  # type: ignore
                data = repair(raw, return_dict=True)
            except Exception:
                data = {}

        data.setdefault("strategy_type", "unknown")
        data.setdefault("collected_parameters", {})
        data.setdefault("missing_parameters", [])
        data.setdefault("is_ready_for_code_generation", False)
        data.setdefault("clarifying_question_for_user", None)
        data.setdefault("enriched_prompt", None)
        data.setdefault("mcp_results_summary", None)
        data.setdefault("verification_step", None)

        vs = data.get("verification_step")
        if isinstance(vs, dict):
            # Map old field names gracefully
            if "mcp_tool_name" in vs and "mcp_tool" not in vs:
                vs["mcp_tool"] = vs.pop("mcp_tool_name")
            data["verification_step"] = OnChainVerification(**vs)
        else:
            data["verification_step"] = None

        try:
            return PlannerState(**data)
        except Exception as exc:
            logger.warning("PlannerState parse error: %s", exc)
            return PlannerState(
                strategy_type="unknown",
                is_ready_for_code_generation=False,
                clarifying_question_for_user=(
                    "Could you give me more details? "
                    "Which tokens, pools, or programs should the bot interact with?"
                ),
            )


# ─── MCP result helpers ───────────────────────────────────────────────────────

def extract_resolved_address(mcp_response: Dict[str, Any]) -> Optional[str]:
    """Extract a Solana base58 pubkey from any MCP response shape."""
    BASE58 = r"^[1-9A-HJ-NP-Za-km-z]{32,44}$"

    # Flat fields
    for field in ("address", "owner", "resolved", "resolved_address", "pubkey"):
        v = mcp_response.get(field)
        if isinstance(v, str) and re.match(BASE58, v.strip()):
            return v.strip()

    # Nested result.data
    result = mcp_response.get("result")
    if isinstance(result, dict):
        data = result.get("data")
        if isinstance(data, str) and re.match(BASE58, data.strip()):
            return data.strip()
        content = result.get("content", [])
        if isinstance(content, list):
            for item in content:
                text = item.get("text", "") if isinstance(item, dict) else ""
                try:
                    inner = json.loads(text)
                    for f in ("address", "owner", "resolved"):
                        if isinstance(inner, dict) and re.match(BASE58, str(inner.get(f, ""))):
                            return str(inner[f])
                except Exception:
                    if re.match(BASE58, str(text).strip()):
                        return str(text).strip()

    return None


def extract_balance_info(mcp_response: Dict[str, Any]) -> Optional[Dict[str, str]]:
    """Extract balance fields from a get_balance or get_token_balance response."""
    out: Dict[str, str] = {}
    for field in ("lamports", "balance", "amount"):
        v = mcp_response.get(field)
        if v is not None:
            out[field] = str(v)
    return out if out else None


def summarise_mcp_result(
    purpose: str,
    payload: Dict[str, Any],
    response: Dict[str, Any],
) -> str:
    lines = [f"MCP Verification [{purpose}]:"]
    lines.append(f"  Query: {json.dumps(payload, separators=(',', ':'))}")

    addr = extract_resolved_address(response)
    bal  = extract_balance_info(response)

    if addr:
        lines.append(f"  Resolved address: {addr}")
    elif bal:
        lines.append(f"  Balance info: {json.dumps(bal)}")
    else:
        lines.append(f"  Raw: {json.dumps(response, separators=(',', ':'))[:500]}")

    return "\n".join(lines)