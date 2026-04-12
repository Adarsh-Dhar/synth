"""
agents/ons_resolver.py  (Solana SNS edition)

Utility helpers for resolving Bonfida SNS (.sol) domain names.
These are dependency-free helpers used by the meta-agent in prompts and tests.
Actual on-chain resolution is delegated to the runtime MCP bridge.
"""

from __future__ import annotations

import json
import re
from typing import Optional

# Matches Bonfida SNS handles such as "alice.sol"
SOL_NAME_PATTERN = re.compile(r"^[a-z0-9_-]+\.sol$", re.IGNORECASE)

# Matches Solana base58 public keys (32–44 chars)
BASE58_PATTERN = re.compile(r"^[1-9A-HJ-NP-Za-km-z]{32,44}$")


def is_sol_name(value: str) -> bool:
    """Return True when the string looks like a Bonfida SNS handle."""
    return bool(SOL_NAME_PATTERN.match(str(value or "").strip()))


def is_sol_address(value: str) -> bool:
    """Return True when the string looks like a Solana base58 public key."""
    return bool(BASE58_PATTERN.match(str(value or "").strip()))


def resolve_if_sol_name(value: str, lookup: dict[str, str] | None = None) -> str:
    """
    Resolve a .sol name using a caller-provided lookup table.
    Actual on-chain SNS resolution happens inside the generated bot's MCP bridge.
    """
    v = str(value or "").strip()
    if not v or not is_sol_name(v):
        return v
    return (lookup or {}).get(v.lower(), v)


def extract_address_from_mcp_response(data: dict, _name: str = "") -> Optional[str]:
    """Best-effort extraction of a Solana pubkey from a MCP response dict."""
    for field in ("address", "owner", "resolved", "resolved_address", "pubkey"):
        v = data.get(field)
        if isinstance(v, str) and is_sol_address(v.strip()):
            return v.strip()

    result = data.get("result")
    if isinstance(result, dict):
        for field in ("address", "owner", "data"):
            v = result.get(field)
            if isinstance(v, str) and is_sol_address(v.strip()):
                return v.strip()

        content = result.get("content")
        if isinstance(content, list):
            for item in content:
                if not isinstance(item, dict):
                    continue
                text = item.get("text", "")
                if not isinstance(text, str):
                    continue
                text = text.strip()
                if text.startswith("{"):
                    try:
                        inner = json.loads(text)
                        for f in ("address", "owner", "resolved"):
                            v = inner.get(f, "")
                            if isinstance(v, str) and is_sol_address(v.strip()):
                                return v.strip()
                    except json.JSONDecodeError:
                        pass
                if is_sol_address(text):
                    return text

    return None