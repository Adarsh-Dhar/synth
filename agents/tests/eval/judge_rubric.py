#!/usr/bin/env python3
"""Lightweight LLM-as-judge style rubric checks for generated bot TypeScript.

This script performs semantic-ish policy checks against generated code with deterministic
heuristics so it can run in CI without external model calls.

NEW: Pass --live-yield-check to also fetch real APY data from Kamino and Marginfi
     and include the live comparison in the rubric report.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
import time
from dataclasses import dataclass
from pathlib import Path
from typing import List, Optional
from urllib import request, error as urllib_error


# ---------------------------------------------------------------------------
# Existing rubric helpers
# ---------------------------------------------------------------------------

@dataclass
class RubricResult:
    name: str
    passed: bool
    detail: str


def check_uses_axios_for_jupiter(code: str, yield_requested: bool) -> RubricResult:
    if yield_requested:
        has_axios_import = bool(re.search(r"\bimport\s+axios\s+from\s+['\"]axios['\"]", code))
        has_yield_source = "kamino" in code.lower() or "marginfi" in code.lower()
        return RubricResult(
            name="uses_axios_for_jupiter",
            passed=has_axios_import and has_yield_source,
            detail="yield mode expects axios import with Kamino/Marginfi API references",
        )

    has_axios_import = bool(re.search(r"\bimport\s+axios\s+from\s+['\"]axios['\"]", code))
    has_jupiter_url = "quote-api.jup.ag" in code
    return RubricResult(
        name="uses_axios_for_jupiter",
        passed=has_axios_import and has_jupiter_url,
        detail="expects axios import and quote-api.jup.ag reference",
    )


def check_no_cli_execution(code: str) -> RubricResult:
    forbidden = ["execSync", "child_process", "jupiter-cli"]
    found = [x for x in forbidden if x in code]
    return RubricResult(
        name="no_cli_execution",
        passed=len(found) == 0,
        detail=f"forbidden tokens found: {found}" if found else "none found",
    )


def check_payment_webhook_when_requested(code: str, requested: bool) -> RubricResult:
    if not requested:
        return RubricResult("payment_webhook_when_requested", True, "not requested")
    has_webhook = bool(re.search(r"payment.*webhook|webhook.*payment|/payment/webhook", code, re.I))
    return RubricResult(
        name="payment_webhook_when_requested",
        passed=has_webhook,
        detail="expects payment webhook handler references",
    )


def check_bigint_for_amounts(code: str) -> RubricResult:
    has_bigint = "BigInt(" in code or re.search(r"\b\d+n\b", code) is not None
    return RubricResult(
        name="bigint_for_amounts",
        passed=has_bigint,
        detail="expects BigInt usage for money arithmetic",
    )


def check_no_hardcoded_addresses(code: str) -> RubricResult:
    # Heuristic: disallow long base58-looking literals unless fetched from env/process
    literals = re.findall(r"['\"]([1-9A-HJ-NP-Za-km-z]{32,44})['\"]", code)
    return RubricResult(
        name="no_hardcoded_addresses",
        passed=len(literals) == 0,
        detail=f"hardcoded address-like literals: {len(literals)}",
    )


def check_yield_has_apy_fetch_tool(code: str, requested: bool) -> RubricResult:
    if not requested:
        return RubricResult("yield_has_apy_fetch_tool", True, "not requested")
    has_fn = bool(re.search(r"\bfetch_lending_apys\s*\(", code))
    has_sources = "kamino" in code.lower() and "marginfi" in code.lower()
    return RubricResult(
        name="yield_has_apy_fetch_tool",
        passed=has_fn and has_sources,
        detail="expects fetch_lending_apys and both Kamino/Marginfi references",
    )


def check_yield_has_60s_loop(code: str, requested: bool) -> RubricResult:
    if not requested:
        return RubricResult("yield_has_60s_loop", True, "not requested")
    has_default_60s = "60000" in code
    has_interval = "setInterval" in code
    return RubricResult(
        name="yield_has_60s_loop",
        passed=has_default_60s and has_interval,
        detail="expects 60000ms default polling and setInterval loop",
    )


def check_yield_has_threshold_logic(code: str, requested: bool) -> RubricResult:
    if not requested:
        return RubricResult("yield_has_threshold_logic", True, "not requested")
    has_threshold_value = "1.5" in code
    has_comparison = bool(re.search(r"delta\s*>=\s*REBALANCE_THRESHOLD_PCT", code))
    return RubricResult(
        name="yield_has_threshold_logic",
        passed=has_threshold_value and has_comparison,
        detail="expects 1.5 threshold default and delta comparison",
    )


def check_yield_reasoning_before_execution(code: str, requested: bool) -> RubricResult:
    if not requested:
        return RubricResult("yield_reasoning_before_execution", True, "not requested")
    has_reasoning_log = "[yield][reasoning]" in code
    has_migration_call = "executeMigration" in code
    return RubricResult(
        name="yield_reasoning_before_execution",
        passed=has_reasoning_log and has_migration_call,
        detail="expects explicit reasoning log before migration",
    )


def check_yield_uses_mcp_execution(code: str, requested: bool) -> RubricResult:
    if not requested:
        return RubricResult("yield_uses_mcp_execution", True, "not requested")
    has_mcp_call = bool(re.search(r"\bcallMcpTool\s*\(", code))
    has_tx_tool = "solana_transaction" in code
    return RubricResult(
        name="yield_uses_mcp_execution",
        passed=has_mcp_call and has_tx_tool,
        detail="expects MCP tool invocation through solana_transaction",
    )


def evaluate(code: str, payment_requested: bool, yield_sweeper_requested: bool) -> List[RubricResult]:
    return [
        check_uses_axios_for_jupiter(code, yield_requested=yield_sweeper_requested),
        check_no_cli_execution(code),
        check_payment_webhook_when_requested(code, requested=payment_requested),
        check_bigint_for_amounts(code),
        check_no_hardcoded_addresses(code),
        check_yield_has_apy_fetch_tool(code, requested=yield_sweeper_requested),
        check_yield_has_60s_loop(code, requested=yield_sweeper_requested),
        check_yield_has_threshold_logic(code, requested=yield_sweeper_requested),
        check_yield_reasoning_before_execution(code, requested=yield_sweeper_requested),
        check_yield_uses_mcp_execution(code, requested=yield_sweeper_requested),
    ]


# ---------------------------------------------------------------------------
# Live yield comparison (new)
# ---------------------------------------------------------------------------

_APY_KEYS_KAMINO = ["supplyApy", "supplyAPY", "supplyApr", "apr", "apy"]
_APY_KEYS_MARGINFI = ["lendingApy", "supplyApy", "apy", "apr", "lendApy"]

_KAMINO_URL = os.environ.get(
    "KAMINO_USDC_APY_URL",
    "https://api.kamino.finance/v1/kamino-market/USDC/reserves",
)
_MARGINFI_URL = os.environ.get(
    "MARGINFI_USDC_APY_URL",
    "https://api.marginfi.com/v1/markets",
)
_REBALANCE_THRESHOLD = float(os.environ.get("REBALANCE_THRESHOLD_PCT", "1.5"))
_LIVE_TIMEOUT = int(os.environ.get("LIVE_YIELD_TIMEOUT_S", "10"))


def _try_read_number(value: object) -> Optional[float]:
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        f = float(value)
        return f if f == f else None
    if isinstance(value, str):
        try:
            f = float(value)
            return f if f == f else None
        except ValueError:
            return None
    return None


def _find_first_numeric(obj: object, keys: list[str]) -> tuple[Optional[float], str]:
    if obj is None:
        return None, ""
    if isinstance(obj, list):
        for item in obj:
            val, key = _find_first_numeric(item, keys)
            if val is not None:
                return val, key
        return None, ""
    if not isinstance(obj, dict):
        return None, ""
    for key in keys:
        if key in obj:
            val = _try_read_number(obj[key])
            if val is not None:
                return val, key
    for child in obj.values():
        val, key = _find_first_numeric(child, keys)
        if val is not None:
            return val, key
    return None, ""


def _normalize_percent(value: float) -> float:
    if 0.0 < value < 1.0:
        return value * 100.0
    return value


def _fetch_json_live(url: str) -> object:
    req = request.Request(url, headers={"User-Agent": "yield-sweeper-rubric/1.0"})
    with request.urlopen(req, timeout=_LIVE_TIMEOUT) as resp:
        return json.loads(resp.read().decode())


@dataclass
class _LiveApyResult:
    protocol: str
    apy_pct: Optional[float]
    key_used: str
    error: Optional[str]


def _fetch_live_apy(url: str, protocol: str, keys: list[str]) -> _LiveApyResult:
    try:
        data = _fetch_json_live(url)
        raw, key_used = _find_first_numeric(data, keys)
        if raw is None:
            return _LiveApyResult(protocol=protocol, apy_pct=None, key_used="", error="no recognisable APY key in response")
        return _LiveApyResult(
            protocol=protocol,
            apy_pct=_normalize_percent(raw),
            key_used=key_used,
            error=None,
        )
    except urllib_error.URLError as exc:
        return _LiveApyResult(protocol=protocol, apy_pct=None, key_used="", error=str(exc))
    except Exception as exc:  # noqa: BLE001
        return _LiveApyResult(protocol=protocol, apy_pct=None, key_used="", error=str(exc))


def run_live_yield_checks(threshold_pct: float = _REBALANCE_THRESHOLD) -> List[RubricResult]:
    """Fetch real APYs from both protocols and return rubric results."""
    results: List[RubricResult] = []

    kamino = _fetch_live_apy(_KAMINO_URL, "kamino", _APY_KEYS_KAMINO)
    marginfi = _fetch_live_apy(_MARGINFI_URL, "marginfi", _APY_KEYS_MARGINFI)

    # --- per-protocol availability checks ---
    results.append(RubricResult(
        name="live_kamino_apy_fetchable",
        passed=kamino.error is None and kamino.apy_pct is not None,
        detail=(
            f"APY={kamino.apy_pct:.4f}% key={kamino.key_used!r}"
            if kamino.apy_pct is not None
            else f"error: {kamino.error}"
        ),
    ))
    results.append(RubricResult(
        name="live_marginfi_apy_fetchable",
        passed=marginfi.error is None and marginfi.apy_pct is not None,
        detail=(
            f"APY={marginfi.apy_pct:.4f}% key={marginfi.key_used!r}"
            if marginfi.apy_pct is not None
            else f"error: {marginfi.error}"
        ),
    ))

    # --- sanity checks on individual APY values ---
    for r in [kamino, marginfi]:
        if r.apy_pct is not None:
            sane = 0.0 < r.apy_pct < 200.0
            results.append(RubricResult(
                name=f"live_{r.protocol}_apy_sane_range",
                passed=sane,
                detail=f"{r.apy_pct:.4f}% {'OK' if sane else 'out of expected 0–200% range'}",
            ))
            in_pct_form = r.apy_pct >= 0.01
            results.append(RubricResult(
                name=f"live_{r.protocol}_apy_in_percent_form",
                passed=in_pct_form,
                detail=(
                    f"{r.apy_pct:.6f} — looks correctly normalised to percent"
                    if in_pct_form
                    else f"{r.apy_pct:.6f} — still looks like a raw fraction; _normalize_percent may have failed"
                ),
            ))

    # --- comparison logic (only when both are available) ---
    if kamino.apy_pct is not None and marginfi.apy_pct is not None:
        delta = abs(kamino.apy_pct - marginfi.apy_pct)
        best_protocol = "kamino" if kamino.apy_pct >= marginfi.apy_pct else "marginfi"
        would_rebalance = delta >= threshold_pct

        results.append(RubricResult(
            name="live_yield_delta_non_negative",
            passed=delta >= 0.0,
            detail=f"delta={delta:.4f}%",
        ))
        results.append(RubricResult(
            name="live_yield_best_protocol_deterministic",
            passed=True,  # informational — always passes but surfaces the winner
            detail=(
                f"best={best_protocol} "
                f"(kamino={kamino.apy_pct:.4f}% marginfi={marginfi.apy_pct:.4f}% "
                f"delta={delta:.4f}% threshold={threshold_pct}%) "
                f"rebalance={'YES' if would_rebalance else 'NO'}"
            ),
        ))
        results.append(RubricResult(
            name="live_yield_rebalance_decision_logged",
            passed=True,  # informational — the decision is always valid
            detail=(
                f"would rebalance to {best_protocol}: delta {delta:.4f}% >= threshold {threshold_pct}%"
                if would_rebalance
                else f"no rebalance: delta {delta:.4f}% < threshold {threshold_pct}%"
            ),
        ))
    else:
        missing = [p.protocol for p in [kamino, marginfi] if p.apy_pct is None]
        results.append(RubricResult(
            name="live_yield_comparison_possible",
            passed=False,
            detail=f"cannot compare — missing data for: {missing}",
        ))

    return results


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def main() -> int:
    parser = argparse.ArgumentParser(description="Run judge rubric on generated TS file")
    parser.add_argument("--file", required=True, help="Path to generated src/index.ts")
    parser.add_argument("--payment-requested", action="store_true", help="Require payment webhook checks")
    parser.add_argument("--yield-sweeper-requested", action="store_true", help="Require yield sweeper loop checks")
    parser.add_argument(
        "--live-yield-check",
        action="store_true",
        help=(
            "Fetch real APY data from Kamino and Marginfi and include live comparison in the report. "
            "Controlled by env vars: KAMINO_USDC_APY_URL, MARGINFI_USDC_APY_URL, "
            "REBALANCE_THRESHOLD_PCT, LIVE_YIELD_TIMEOUT_S."
        ),
    )
    parser.add_argument("--json", action="store_true", help="Print JSON output")
    args = parser.parse_args()

    code = Path(args.file).read_text(encoding="utf-8")
    results = evaluate(
        code,
        payment_requested=args.payment_requested,
        yield_sweeper_requested=args.yield_sweeper_requested,
    )

    if args.live_yield_check:
        live_results = run_live_yield_checks()
        results.extend(live_results)

    passed = all(r.passed for r in results)

    if args.json:
        print(json.dumps({"passed": passed, "results": [r.__dict__ for r in results]}, indent=2))
    else:
        # Group static vs live for readability
        static = [r for r in results if not r.name.startswith("live_")]
        live = [r for r in results if r.name.startswith("live_")]

        if static:
            print("\n── Static rubric checks ──")
            for r in static:
                print(f"[{'PASS' if r.passed else 'FAIL'}] {r.name}: {r.detail}")

        if live:
            print("\n── Live yield checks ──")
            for r in live:
                print(f"[{'PASS' if r.passed else 'FAIL'}] {r.name}: {r.detail}")

        print(f"\noverall: {'PASS' if passed else 'FAIL'}")

    return 0 if passed else 1


if __name__ == "__main__":
    sys.exit(main())