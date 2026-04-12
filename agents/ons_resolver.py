"""
Utility helpers for resolving Solana Name Service (.sol) usernames.

The actual SNS registry may vary by network, so the resolver keeps those values
configurable. These helpers are intentionally small and dependency-free so the
meta-agent can reuse them in prompts, tests, or automation paths.
"""

from __future__ import annotations

import json
import re
from typing import Optional


SOL_NAME_PATTERN = re.compile(r"^[a-z0-9_-]+\.sol$", re.IGNORECASE)


def is_sol_name(value: str) -> bool:
    """Return True when the string looks like a .sol SNS handle."""
    return bool(SOL_NAME_PATTERN.match(str(value or "").strip()))


def resolve_if_sol_name(value: str, resolved_lookup: dict[str, str] | None = None) -> str:
    """
    Resolve a .sol name via a caller-provided lookup table.

    The actual SNS resolution happens through the generated runtime's MCP bridge
    or the Solana MCP shim; this helper just performs a simple lookup override
    when provided.
    """
    candidate = str(value or "").strip()
    if not candidate or not is_sol_name(candidate):
        return candidate

    lookup = resolved_lookup or {}
    return lookup.get(candidate.lower(), candidate)


def extract_address_from_mcp_response(data: dict, name: str) -> Optional[str]:
    """Best-effort extraction for MCP move_view payloads."""
    for field in ("address", "value", "resolved_address", "account"):
        value = data.get(field)
        if isinstance(value, str) and value.strip():
            return value.strip()

    result = data.get("result")
    if isinstance(result, dict):
        content = result.get("content")
        if isinstance(content, list) and content:
            first = content[0]
            if isinstance(first, dict):
                text = first.get("text")
                if isinstance(text, str):
                    trimmed = text.strip()
                    if trimmed.startswith("{"):
                        try:
                            inner = json.loads(trimmed)
                        except json.JSONDecodeError:
                            inner = None
                        if isinstance(inner, dict):
                            for field in ("address", "resolved_address", "value"):
                                inner_value = inner.get(field)
                                if isinstance(inner_value, str) and inner_value.strip():
                                    return inner_value.strip()
                    # Heuristic: return base58-looking strings as Solana addresses
                    if re.match(r'^[1-9A-HJ-NP-Za-km-z]{32,64}$', trimmed):
                        return trimmed

    return None
