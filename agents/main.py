"""
agents/main.py — Production Meta-Agent
=======================================
Spawns both MCP servers as subprocesses and exposes their tools
to an async Python orchestrator.

Architecture:
  GoldRush MCP  → Solana on-chain data (read-only oracle)
  Jupiter MCP   → Docs context, live quotes, bot code generation

Usage:
  python main.py

Required env vars:
  GOLDRUSH_API_KEY   — Covalent GoldRush key
  JUPITER_API_KEY    — Jupiter API key (optional for public endpoints)

Optional env vars:
  AGENTS_DIR         — Override path to the agents/ directory
  LOG_LEVEL          — DEBUG | INFO | WARNING (default: INFO)
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import sys
from pathlib import Path
from typing import Any

# ── pip install mcp ──
from mcp import ClientSession, StdioServerParameters
from mcp.client.stdio import stdio_client

# ─────────────────────────────────────────────
# Logging
# ─────────────────────────────────────────────

logging.basicConfig(
    level=getattr(logging, os.environ.get("LOG_LEVEL", "INFO").upper(), logging.INFO),
    format="%(asctime)s [%(levelname)s] %(name)s — %(message)s",
    datefmt="%H:%M:%S",
    stream=sys.stderr,
)
log = logging.getLogger("meta-agent")

# ─────────────────────────────────────────────
# Paths
# ─────────────────────────────────────────────

AGENTS_DIR = Path(os.environ.get("AGENTS_DIR", Path(__file__).parent))

GOLDRUSH_SERVER = AGENTS_DIR / "goldrush-mcp-server" / "dist" / "index.js"
JUPITER_SERVER = AGENTS_DIR / "jupiter-mcp-server" / "dist" / "index.js"

# During development, fall back to tsx (no build required)
GOLDRUSH_DEV_ENTRY = AGENTS_DIR / "goldrush-mcp-server" / "src" / "index.ts"
JUPITER_DEV_ENTRY = AGENTS_DIR / "jupiter-mcp-server" / "src" / "index.ts"


def _server_params(dist_path: Path, dev_entry: Path, extra_env: dict[str, str] | None = None) -> StdioServerParameters:
    """Return StdioServerParameters, preferring built dist/ over tsx dev mode."""
    env = {**os.environ}
    if extra_env:
        env.update(extra_env)

    if dist_path.exists():
        log.debug("Using built server: %s", dist_path)
        return StdioServerParameters(command="node", args=["--enable-source-maps", str(dist_path)], env=env)

    if dev_entry.exists():
        log.warning(
            "Built server not found at %s — falling back to tsx (dev mode). Run `npm run build` for production.",
            dist_path,
        )
        return StdioServerParameters(command="npx", args=["tsx", str(dev_entry)], env=env)

    raise FileNotFoundError(
        f"Cannot find server binary at {dist_path} or dev entry at {dev_entry}. "
        "Run `npm run build` inside the server directory."
    )


# ─────────────────────────────────────────────
# Session helpers
# ─────────────────────────────────────────────


async def list_tools(session: ClientSession) -> list[str]:
    """Return the names of all tools exposed by an MCP session."""
    resp = await session.list_tools()
    return [t.name for t in resp.tools]


async def call_tool(session: ClientSession, name: str, args: dict[str, Any]) -> Any:
    """
    Call a tool and return the parsed result.

    Raises RuntimeError if the tool signals an error.
    """
    result = await session.call_tool(name, arguments=args)

    if result.isError:
        content = result.content[0].text if result.content else "(no content)"
        raise RuntimeError(f"Tool '{name}' returned an error: {content}")

    raw = result.content[0].text if result.content else "{}"
    try:
        return json.loads(raw)
    except json.JSONDecodeError:
        return raw  # Return as plain text if not JSON


# ─────────────────────────────────────────────
# Demo workflow
# ─────────────────────────────────────────────


async def demo_workflow(
    goldrush: ClientSession,
    jupiter: ClientSession,
    target_wallet: str,
    strategy: str = "copy_trade",
) -> None:
    """
    Example orchestration:
    1. Validate the target wallet via GoldRush
    2. Search Jupiter docs for the requested strategy
    3. Generate bot code
    4. Get a live quote to validate the swap parameters

    Replace this function with your real agent logic.
    """
    log.info("═══ Step 1: Fetch wallet balances (GoldRush) ═══")
    balances = await call_tool(goldrush, "get_token_balances", {"wallet": target_wallet})
    items = (balances or {}).get("items", [])
    log.info("Wallet %s holds %d token(s).", target_wallet[:8] + "…", len(items))
    for item in items[:5]:
        symbol = item.get("contract_ticker_symbol", "?")
        usd = item.get("quote", 0)
        log.info("  %-10s  $%.2f", symbol, usd)

    log.info("")
    log.info("═══ Step 2: Fetch recent transactions (GoldRush) ═══")
    txns = await call_tool(
        goldrush, "get_transactions", {"wallet": target_wallet, "page_size": 5}
    )
    tx_items = (txns or {}).get("items", [])
    log.info("Latest %d transaction(s):", len(tx_items))
    for tx in tx_items:
        log.info("  %s  %s", tx.get("tx_hash", "?")[:16] + "…", tx.get("block_signed_at", ""))

    log.info("")
    log.info("═══ Step 3: Search Jupiter docs for strategy ═══")
    docs = await call_tool(jupiter, "search_docs", {"query": strategy.replace("_", " "), "include_examples": True})
    if isinstance(docs, list):
        for doc in docs[:2]:
            log.info("  [%s] %s", doc.get("id"), doc.get("title"))
    else:
        log.info("  %s", docs)

    log.info("")
    log.info("═══ Step 4: Generate bot code ═══")
    bot = await call_tool(
        jupiter,
        "generate_bot_code",
        {
            "strategy": strategy,
            "params": {
                "target_wallet": target_wallet,
                "position_size_usdc": 100,
            },
        },
    )
    filename = bot.get("filename", "bot.ts")
    code_snippet = (bot.get("code", "") or "")[:300]
    log.info("Generated: %s", filename)
    log.info("Code preview:\n%s…", code_snippet)

    log.info("")
    log.info("═══ Step 5: Get live quote (Jupiter) ═══")
    SOL_MINT = "So11111111111111111111111111111111111111112"
    USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"
    try:
        quote_result = await call_tool(
            jupiter,
            "get_quote",
            {
                "input_mint": SOL_MINT,
                "output_mint": USDC_MINT,
                "amount": 1_000_000_000,  # 1 SOL
                "slippage_bps": 50,
            },
        )
        quote = quote_result.get("quote", {})
        out_amount = int(quote.get("outAmount", 0)) / 1_000_000  # USDC has 6 decimals
        log.info("1 SOL → %.2f USDC (slippage ≤ 0.5%%)", out_amount)
    except RuntimeError as exc:
        log.warning("Quote failed (expected outside Solana network): %s", exc)

    log.info("")
    log.info("✓ Workflow complete. Bot file '%s' is ready to save.", filename)


# ─────────────────────────────────────────────
# Entry point
# ─────────────────────────────────────────────


async def main() -> None:
    # Validate required keys
    if not os.environ.get("GOLDRUSH_API_KEY"):
        log.error("GOLDRUSH_API_KEY is not set. Cannot start.")
        sys.exit(1)

    goldrush_params = _server_params(GOLDRUSH_SERVER, GOLDRUSH_DEV_ENTRY)
    jupiter_params = _server_params(JUPITER_SERVER, JUPITER_DEV_ENTRY)

    log.info("Connecting to GoldRush MCP server…")
    log.info("Connecting to Jupiter MCP server…")

    async with (
        stdio_client(goldrush_params) as (gr_read, gr_write),
        stdio_client(jupiter_params) as (jup_read, jup_write),
    ):
        async with (
            ClientSession(gr_read, gr_write) as goldrush,
            ClientSession(jup_read, jup_write) as jupiter,
        ):
            await goldrush.initialize()
            await jupiter.initialize()

            gr_tools = await list_tools(goldrush)
            jup_tools = await list_tools(jupiter)
            log.info("GoldRush tools: %s", gr_tools)
            log.info("Jupiter tools:  %s", jup_tools)

            # ── Replace with your target wallet and strategy ──
            TARGET_WALLET = os.environ.get(
                "TARGET_WALLET",
                "7VHUFyQ3G16i1mLexiBb5e7abmQmvBp7EBrE8mGq4pXb",  # example only
            )
            STRATEGY = os.environ.get("BOT_STRATEGY", "copy_trade")

            await demo_workflow(goldrush, jupiter, TARGET_WALLET, STRATEGY)


if __name__ == "__main__":
    asyncio.run(main())