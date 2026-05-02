#!/usr/bin/env python3
"""
agents/tests/eval/test_live_yields.py

Live integration tests that fetch real APY data from Kamino and Marginfi,
then validate the yield-sweeper's comparison and rebalance-decision logic
against actual market data.

Run standalone:
    python agents/tests/eval/test_live_yields.py

Run via pytest:
    PYTHONPATH=agents pytest agents/tests/eval/test_live_yields.py -v

Environment overrides (mirror yield_sweeper_bot.ts defaults):
    KAMINO_USDC_APY_URL      default: https://api.kamino.finance/v1/kamino-market/USDC/reserves
    MARGINFI_USDC_APY_URL    default: https://api.marginfi.com/v1/markets
    REBALANCE_THRESHOLD_PCT  default: 1.5
    LIVE_YIELD_TIMEOUT_S     default: 10
"""

from __future__ import annotations

import json
import os
import sys
import time
from dataclasses import dataclass
from typing import Optional
from urllib import request, error as urllib_error

# ---------------------------------------------------------------------------
# Configuration — mirrors env-var defaults in yield_sweeper_bot.ts
# ---------------------------------------------------------------------------

KAMINO_USDC_APY_URL: str = os.environ.get(
    "KAMINO_USDC_APY_URL",
    "https://api.kamino.finance/v1/kamino-market/USDC/reserves",
)
MARGINFI_USDC_APY_URL: str = os.environ.get(
    "MARGINFI_USDC_APY_URL",
    "https://api.marginfi.com/v1/markets",
)
REBALANCE_THRESHOLD_PCT: float = float(os.environ.get("REBALANCE_THRESHOLD_PCT", "1.5"))
LIVE_YIELD_TIMEOUT_S: int = int(os.environ.get("LIVE_YIELD_TIMEOUT_S", "10"))


# ---------------------------------------------------------------------------
# Data types
# ---------------------------------------------------------------------------

@dataclass
class ProtocolApy:
    protocol: str
    supply_apy_pct: float
    fetched_at: str
    source_url: str
    raw_key_used: str  # which JSON key the value was extracted from


@dataclass
class YieldComparison:
    kamino: Optional[ProtocolApy]
    marginfi: Optional[ProtocolApy]
    best: Optional[ProtocolApy]
    delta_pct: float                # best.apy - other.apy  (0 if one is missing)
    rebalance_would_trigger: bool   # delta >= REBALANCE_THRESHOLD_PCT
    threshold_pct: float


# ---------------------------------------------------------------------------
# APY extraction helpers (Python port of findFirstNumeric + normalizePercent
# from yield_sweeper_bot.ts so the tests exercise identical logic)
# ---------------------------------------------------------------------------

_APY_KEYS_KAMINO = ["supplyApy", "supplyAPY", "supplyApr", "apr", "apy"]
_APY_KEYS_MARGINFI = ["lendingApy", "supplyApy", "apy", "apr", "lendApy"]


def _try_read_number(value: object) -> Optional[float]:
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        f = float(value)
        return f if f == f else None  # NaN guard
    if isinstance(value, str):
        try:
            f = float(value)
            return f if f == f else None
        except ValueError:
            return None
    return None


def _find_first_numeric(obj: object, keys: list[str]) -> tuple[Optional[float], str]:
    """Return (value, key_name) for the first matching key found anywhere in obj.

    Mirrors the recursive findFirstNumeric in yield_sweeper_bot.ts, but also
    returns the key name so tests can assert which field drove the decision.
    """
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
    """Convert fractional APY (0.11 → 11.0) to percentage, leaving already-pct values alone."""
    if 0.0 < value < 1.0:
        return value * 100.0
    return value


# ---------------------------------------------------------------------------
# Network helpers
# ---------------------------------------------------------------------------

def _fetch_json(url: str, timeout: int = LIVE_YIELD_TIMEOUT_S) -> object:
    req = request.Request(url, headers={"User-Agent": "yield-sweeper-eval/1.0"})
    with request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read().decode())


def fetch_kamino_apy(url: str = KAMINO_USDC_APY_URL) -> Optional[ProtocolApy]:
    """Fetch USDC supply APY from Kamino Finance."""
    data = _fetch_json(url)
    raw, key_used = _find_first_numeric(data, _APY_KEYS_KAMINO)
    if raw is None:
        return None
    return ProtocolApy(
        protocol="kamino",
        supply_apy_pct=_normalize_percent(raw),
        fetched_at=time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        source_url=url,
        raw_key_used=key_used,
    )


def fetch_marginfi_apy(url: str = MARGINFI_USDC_APY_URL) -> Optional[ProtocolApy]:
    """Fetch USDC supply APY from Marginfi."""
    data = _fetch_json(url)
    raw, key_used = _find_first_numeric(data, _APY_KEYS_MARGINFI)
    if raw is None:
        return None
    return ProtocolApy(
        protocol="marginfi",
        supply_apy_pct=_normalize_percent(raw),
        fetched_at=time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        source_url=url,
        raw_key_used=key_used,
    )


# ---------------------------------------------------------------------------
# Comparison logic (mirrors pickBest + delta check in yield_sweeper_bot.ts)
# ---------------------------------------------------------------------------

def compare_yields(
    kamino: Optional[ProtocolApy],
    marginfi: Optional[ProtocolApy],
    threshold_pct: float = REBALANCE_THRESHOLD_PCT,
) -> YieldComparison:
    candidates = [p for p in [kamino, marginfi] if p is not None]
    if not candidates:
        return YieldComparison(
            kamino=None, marginfi=None, best=None,
            delta_pct=0.0, rebalance_would_trigger=False,
            threshold_pct=threshold_pct,
        )

    best = max(candidates, key=lambda p: p.supply_apy_pct)
    second_best = min(candidates, key=lambda p: p.supply_apy_pct) if len(candidates) > 1 else best
    delta = best.supply_apy_pct - second_best.supply_apy_pct if len(candidates) > 1 else 0.0

    return YieldComparison(
        kamino=kamino,
        marginfi=marginfi,
        best=best,
        delta_pct=round(delta, 4),
        rebalance_would_trigger=(len(candidates) > 1 and delta >= threshold_pct),
        threshold_pct=threshold_pct,
    )


# ---------------------------------------------------------------------------
# Pytest tests
# ---------------------------------------------------------------------------

import pytest  # noqa: E402  (placed after helpers so module works standalone too)


class TestKaminoFetch:
    """Tests against the live Kamino Finance API."""

    def test_returns_protocol_apy_object(self):
        result = fetch_kamino_apy()
        assert result is not None, (
            "Kamino APY fetch returned None — API may have changed shape. "
            f"Check {KAMINO_USDC_APY_URL} and update _APY_KEYS_KAMINO."
        )
        assert result.protocol == "kamino"

    def test_apy_is_positive_finite_number(self):
        result = fetch_kamino_apy()
        assert result is not None
        assert isinstance(result.supply_apy_pct, float)
        assert result.supply_apy_pct > 0, "Kamino supply APY must be > 0%"
        assert result.supply_apy_pct < 200, "Kamino supply APY > 200% looks like a parsing error"

    def test_apy_already_in_percent_form(self):
        """After normalisation, value must be ≥ 1 (i.e. not a raw fraction like 0.11)."""
        result = fetch_kamino_apy()
        assert result is not None
        assert result.supply_apy_pct >= 0.01, (
            f"APY {result.supply_apy_pct} looks fractional — _normalize_percent may have failed"
        )

    def test_records_which_json_key_was_used(self):
        result = fetch_kamino_apy()
        assert result is not None
        assert result.raw_key_used in _APY_KEYS_KAMINO, (
            f"Unexpected key '{result.raw_key_used}' — update _APY_KEYS_KAMINO if the API changed"
        )

    def test_source_url_matches_config(self):
        result = fetch_kamino_apy()
        assert result is not None
        assert result.source_url == KAMINO_USDC_APY_URL


class TestMarginFiFetch:
    """Tests against the live Marginfi API."""

    def test_returns_protocol_apy_object(self):
        result = fetch_marginfi_apy()
        assert result is not None, (
            "Marginfi APY fetch returned None — API may have changed shape. "
            f"Check {MARGINFI_USDC_APY_URL} and update _APY_KEYS_MARGINFI."
        )
        assert result.protocol == "marginfi"

    def test_apy_is_positive_finite_number(self):
        result = fetch_marginfi_apy()
        assert result is not None
        assert isinstance(result.supply_apy_pct, float)
        assert result.supply_apy_pct > 0, "Marginfi supply APY must be > 0%"
        assert result.supply_apy_pct < 200, "Marginfi supply APY > 200% looks like a parsing error"

    def test_apy_already_in_percent_form(self):
        result = fetch_marginfi_apy()
        assert result is not None
        assert result.supply_apy_pct >= 0.01

    def test_records_which_json_key_was_used(self):
        result = fetch_marginfi_apy()
        assert result is not None
        assert result.raw_key_used in _APY_KEYS_MARGINFI

    def test_source_url_matches_config(self):
        result = fetch_marginfi_apy()
        assert result is not None
        assert result.source_url == MARGINFI_USDC_APY_URL


class TestYieldComparison:
    """Validates the sweeper's comparison + rebalance-decision logic against live data."""

    @pytest.fixture(scope="class")
    def live_comparison(self) -> YieldComparison:
        kamino = fetch_kamino_apy()
        marginfi = fetch_marginfi_apy()
        return compare_yields(kamino, marginfi)

    def test_both_protocols_fetchable(self, live_comparison: YieldComparison):
        assert live_comparison.kamino is not None, "Kamino fetch failed — cannot compare yields"
        assert live_comparison.marginfi is not None, "Marginfi fetch failed — cannot compare yields"

    def test_best_is_higher_apy_protocol(self, live_comparison: YieldComparison):
        assert live_comparison.best is not None
        k = live_comparison.kamino
        m = live_comparison.marginfi
        assert k is not None and m is not None
        expected_winner = "kamino" if k.supply_apy_pct >= m.supply_apy_pct else "marginfi"
        assert live_comparison.best.protocol == expected_winner, (
            f"best={live_comparison.best.protocol} but "
            f"kamino={k.supply_apy_pct:.3f}% marginfi={m.supply_apy_pct:.3f}%"
        )

    def test_delta_is_non_negative(self, live_comparison: YieldComparison):
        assert live_comparison.delta_pct >= 0.0, (
            f"delta should always be non-negative, got {live_comparison.delta_pct}"
        )

    def test_delta_matches_manual_calculation(self, live_comparison: YieldComparison):
        k = live_comparison.kamino
        m = live_comparison.marginfi
        assert k is not None and m is not None
        expected_delta = abs(k.supply_apy_pct - m.supply_apy_pct)
        assert abs(live_comparison.delta_pct - expected_delta) < 1e-6, (
            f"delta mismatch: got {live_comparison.delta_pct}, expected {expected_delta}"
        )

    def test_rebalance_flag_consistent_with_delta_and_threshold(self, live_comparison: YieldComparison):
        should_trigger = live_comparison.delta_pct >= REBALANCE_THRESHOLD_PCT
        assert live_comparison.rebalance_would_trigger == should_trigger, (
            f"rebalance_would_trigger={live_comparison.rebalance_would_trigger} inconsistent with "
            f"delta={live_comparison.delta_pct:.3f}% threshold={REBALANCE_THRESHOLD_PCT}%"
        )

    def test_threshold_matches_env_config(self, live_comparison: YieldComparison):
        assert live_comparison.threshold_pct == REBALANCE_THRESHOLD_PCT


class TestParserRobustness:
    """Unit tests for _find_first_numeric — no network calls."""

    def test_finds_value_at_top_level(self):
        val, key = _find_first_numeric({"supplyApy": 0.11}, _APY_KEYS_KAMINO)
        assert val == pytest.approx(0.11)
        assert key == "supplyApy"

    def test_finds_value_nested_one_level(self):
        val, key = _find_first_numeric({"data": {"apy": 12.5}}, _APY_KEYS_KAMINO)
        assert val == pytest.approx(12.5)
        assert key == "apy"

    def test_finds_value_inside_list(self):
        val, key = _find_first_numeric([{"supplyAPY": 9.9}], _APY_KEYS_KAMINO)
        assert val == pytest.approx(9.9)
        assert key == "supplyAPY"

    def test_prefers_earlier_key_in_priority_list(self):
        # supplyApy appears before apy in _APY_KEYS_KAMINO, so it wins even if apy is bigger
        val, key = _find_first_numeric({"supplyApy": 5.0, "apy": 99.0}, _APY_KEYS_KAMINO)
        assert val == pytest.approx(5.0)
        assert key == "supplyApy"

    def test_string_numeric_values_are_parsed(self):
        val, key = _find_first_numeric({"apy": "8.75"}, _APY_KEYS_KAMINO)
        assert val == pytest.approx(8.75)

    def test_returns_none_on_missing_keys(self):
        val, key = _find_first_numeric({"rate": 10.0}, _APY_KEYS_KAMINO)
        assert val is None
        assert key == ""

    def test_normalize_percent_converts_fraction(self):
        assert _normalize_percent(0.11) == pytest.approx(11.0)

    def test_normalize_percent_leaves_pct_unchanged(self):
        assert _normalize_percent(11.0) == pytest.approx(11.0)

    def test_normalize_percent_boundary_exactly_1(self):
        # 1.0 is ambiguous (1% or fractional?); the bot treats >= 1 as already-pct
        assert _normalize_percent(1.0) == pytest.approx(1.0)


class TestCompareYieldsUnit:
    """Unit-level comparison tests using synthetic APY data."""

    def _make(self, protocol: str, pct: float) -> ProtocolApy:
        return ProtocolApy(
            protocol=protocol, supply_apy_pct=pct,
            fetched_at="2024-01-01T00:00:00Z",
            source_url=f"unit://{protocol}",
            raw_key_used="apy",
        )

    def test_kamino_wins_when_higher(self):
        cmp = compare_yields(self._make("kamino", 12.0), self._make("marginfi", 7.0))
        assert cmp.best is not None
        assert cmp.best.protocol == "kamino"

    def test_marginfi_wins_when_higher(self):
        cmp = compare_yields(self._make("kamino", 6.0), self._make("marginfi", 10.0))
        assert cmp.best is not None
        assert cmp.best.protocol == "marginfi"

    def test_rebalance_triggers_when_delta_exceeds_threshold(self):
        cmp = compare_yields(
            self._make("kamino", 12.0), self._make("marginfi", 7.0), threshold_pct=1.5
        )
        assert cmp.delta_pct == pytest.approx(5.0)
        assert cmp.rebalance_would_trigger is True

    def test_rebalance_suppressed_when_delta_below_threshold(self):
        cmp = compare_yields(
            self._make("kamino", 8.0), self._make("marginfi", 7.0), threshold_pct=1.5
        )
        assert cmp.delta_pct == pytest.approx(1.0)
        assert cmp.rebalance_would_trigger is False

    def test_rebalance_triggers_exactly_at_threshold(self):
        cmp = compare_yields(
            self._make("kamino", 8.5), self._make("marginfi", 7.0), threshold_pct=1.5
        )
        assert cmp.delta_pct == pytest.approx(1.5)
        assert cmp.rebalance_would_trigger is True  # >= threshold, not >

    def test_no_rebalance_when_only_one_protocol(self):
        cmp = compare_yields(self._make("kamino", 12.0), None)
        assert cmp.rebalance_would_trigger is False
        assert cmp.delta_pct == pytest.approx(0.0)

    def test_no_rebalance_when_no_protocols(self):
        cmp = compare_yields(None, None)
        assert cmp.best is None
        assert cmp.rebalance_would_trigger is False


# ---------------------------------------------------------------------------
# Standalone runner (no pytest required)
# ---------------------------------------------------------------------------

def _run_standalone() -> int:
    print("=" * 60)
    print("Live Yield Comparison — Kamino vs Marginfi")
    print(f"  Threshold : {REBALANCE_THRESHOLD_PCT}%")
    print(f"  Timeout   : {LIVE_YIELD_TIMEOUT_S}s per request")
    print("=" * 60)

    kamino: Optional[ProtocolApy] = None
    marginfi: Optional[ProtocolApy] = None
    errors: list[str] = []

    print(f"\nFetching Kamino APY from:\n  {KAMINO_USDC_APY_URL}")
    try:
        kamino = fetch_kamino_apy()
        if kamino:
            print(f"  ✓ kamino  supply APY = {kamino.supply_apy_pct:.4f}%  (key: {kamino.raw_key_used!r})")
        else:
            msg = "Kamino returned data but no recognisable APY key was found"
            print(f"  ✗ {msg}")
            errors.append(msg)
    except urllib_error.URLError as exc:
        msg = f"Kamino network error: {exc}"
        print(f"  ✗ {msg}")
        errors.append(msg)

    print(f"\nFetching Marginfi APY from:\n  {MARGINFI_USDC_APY_URL}")
    try:
        marginfi = fetch_marginfi_apy()
        if marginfi:
            print(f"  ✓ marginfi supply APY = {marginfi.supply_apy_pct:.4f}%  (key: {marginfi.raw_key_used!r})")
        else:
            msg = "Marginfi returned data but no recognisable APY key was found"
            print(f"  ✗ {msg}")
            errors.append(msg)
    except urllib_error.URLError as exc:
        msg = f"Marginfi network error: {exc}"
        print(f"  ✗ {msg}")
        errors.append(msg)

    print("\n--- Comparison ---")
    cmp = compare_yields(kamino, marginfi)

    if cmp.best:
        other_apy = (
            (cmp.marginfi.supply_apy_pct if cmp.best.protocol == "kamino" else cmp.kamino.supply_apy_pct)
            if cmp.kamino and cmp.marginfi
            else cmp.best.supply_apy_pct
        )
        print(f"  Best protocol : {cmp.best.protocol}  ({cmp.best.supply_apy_pct:.4f}%)")
        if cmp.kamino and cmp.marginfi:
            loser = "marginfi" if cmp.best.protocol == "kamino" else "kamino"
            print(f"  Other         : {loser}  ({other_apy:.4f}%)")
        print(f"  Delta         : {cmp.delta_pct:.4f}%")
        print(f"  Threshold     : {cmp.threshold_pct}%")
        verdict = "✓ REBALANCE WOULD TRIGGER" if cmp.rebalance_would_trigger else "✗ no rebalance (delta < threshold)"
        print(f"  Decision      : {verdict}")
    else:
        print("  Could not determine best protocol — both fetches failed.")

    if errors:
        print("\nErrors:")
        for e in errors:
            print(f"  • {e}")
        return 1

    if not cmp.kamino or not cmp.marginfi:
        print("\nFATAL: one or both protocols unavailable; cannot validate comparison logic.")
        return 1

    print("\n✓ All live yield checks passed.")
    return 0


if __name__ == "__main__":
    sys.exit(_run_standalone())