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


def check_uses_axios_for_jupiter(code: str) -> RubricResult:
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


def evaluate(code: str, dodo_requested: bool) -> List[RubricResult]:
    return [
        check_uses_axios_for_jupiter(code),
        check_no_cli_execution(code),
        check_dodo_webhook_when_requested(code, requested=dodo_requested),
        check_bigint_for_amounts(code),
        check_no_hardcoded_addresses(code),
    ]


def main() -> int:
    parser = argparse.ArgumentParser(description="Run judge rubric on generated TS file")
    parser.add_argument("--file", required=True, help="Path to generated src/index.ts")
    parser.add_argument("--dodo-requested", action="store_true", help="Require Dodo webhook checks")
    parser.add_argument("--json", action="store_true", help="Print JSON output")
    args = parser.parse_args()

    code = Path(args.file).read_text(encoding="utf-8")
    results = evaluate(code, dodo_requested=args.dodo_requested)
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
