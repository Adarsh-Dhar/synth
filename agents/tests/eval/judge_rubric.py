#!/usr/bin/env python3
"""Lightweight LLM-as-judge style rubric checks for generated bot TypeScript.

This script performs semantic-ish policy checks against generated code with deterministic
heuristics so it can run in CI without external model calls.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import List


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


def check_dodo_webhook_when_requested(code: str, requested: bool) -> RubricResult:
    if not requested:
        return RubricResult("dodo_webhook_when_requested", True, "not requested")
    has_webhook = bool(re.search(r"dodo.*webhook|webhook.*dodo|/dodo/webhook", code, re.I))
    return RubricResult(
        name="dodo_webhook_when_requested",
        passed=has_webhook,
        detail="expects Dodo webhook handler references",
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


def evaluate(code: str, dodo_requested: bool, yield_sweeper_requested: bool) -> List[RubricResult]:
    return [
        check_uses_axios_for_jupiter(code, yield_requested=yield_sweeper_requested),
        check_no_cli_execution(code),
        check_dodo_webhook_when_requested(code, requested=dodo_requested),
        check_bigint_for_amounts(code),
        check_no_hardcoded_addresses(code),
        check_yield_has_apy_fetch_tool(code, requested=yield_sweeper_requested),
        check_yield_has_60s_loop(code, requested=yield_sweeper_requested),
        check_yield_has_threshold_logic(code, requested=yield_sweeper_requested),
        check_yield_reasoning_before_execution(code, requested=yield_sweeper_requested),
        check_yield_uses_mcp_execution(code, requested=yield_sweeper_requested),
    ]


def main() -> int:
    parser = argparse.ArgumentParser(description="Run judge rubric on generated TS file")
    parser.add_argument("--file", required=True, help="Path to generated src/index.ts")
    parser.add_argument("--dodo-requested", action="store_true", help="Require Dodo webhook checks")
    parser.add_argument("--yield-sweeper-requested", action="store_true", help="Require yield sweeper loop checks")
    parser.add_argument("--json", action="store_true", help="Print JSON output")
    args = parser.parse_args()

    code = Path(args.file).read_text(encoding="utf-8")
    results = evaluate(
        code,
        dodo_requested=args.dodo_requested,
        yield_sweeper_requested=args.yield_sweeper_requested,
    )
    passed = all(r.passed for r in results)

    if args.json:
        print(json.dumps({"passed": passed, "results": [r.__dict__ for r in results]}, indent=2))
    else:
        for r in results:
            print(f"[{ 'PASS' if r.passed else 'FAIL' }] {r.name}: {r.detail}")
        print(f"overall: {'PASS' if passed else 'FAIL'}")

    return 0 if passed else 1


if __name__ == "__main__":
    sys.exit(main())
