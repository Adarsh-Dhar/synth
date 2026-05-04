"""
agents/jupiter_prompt.py

Jupiter Developer Platform — Context Injector for the Meta-Agent
=================================================================
Loads the Jupiter API key from agents/.env and builds rich, structured
system-prompt context for every Jupiter API product.  This module is
imported by orchestrator.py and injected into the LLM system prompt so
the generator always knows:
  - the correct base URL and auth header
  - the exact endpoint shape for every product
  - which Swap path to use (Meta-Aggregator vs Router)
  - the MCP tools available via jupiter-mcp-server

Usage
-----
    from jupiter_prompt import (
        JUPITER_API_KEY,
        JUPITER_BASE_URL,
        JUPITER_SYSTEM_CONTEXT,
        build_jupiter_user_context,
        get_mcp_tool_descriptions,
    )

    # Inject into LLM system prompt
    full_system = f"{GENERATOR_SYSTEM}\n\n{JUPITER_SYSTEM_CONTEXT}"

    # Build per-request user context (with live price data if desired)
    user_ctx = await build_jupiter_user_context(strategy="yield_sweeper")
"""

from __future__ import annotations

import os
from pathlib import Path
from typing import Optional

from dotenv import load_dotenv

# ─── Load .env ────────────────────────────────────────────────────────────────

_BASE_DIR = Path(__file__).resolve().parent
load_dotenv(_BASE_DIR / ".env")
load_dotenv(_BASE_DIR / ".env.local", override=True)

JUPITER_API_KEY: str = os.environ.get("JUPITER_API_KEY", "").strip()
JUPITER_BASE_URL: str = os.environ.get(
    "JUPITER_BASE_URL", "https://api.jup.ag"
).rstrip("/")

if not JUPITER_API_KEY:
    import warnings
    warnings.warn(
        "[jupiter_prompt] JUPITER_API_KEY not found in agents/.env. "
        "All API calls will be rate-limited to the public free tier.",
        stacklevel=2,
    )

# ─── Auth header snippet ──────────────────────────────────────────────────────

_AUTH_HEADER_TS = f'headers: {{ "x-api-key": process.env.JUPITER_API_KEY ?? "" }}'
_AUTH_HEADER_PY = 'headers={"x-api-key": os.environ["JUPITER_API_KEY"]}'

# ══════════════════════════════════════════════════════════════════════════════
# JUPITER SYSTEM CONTEXT  — injected into the LLM system prompt
# ══════════════════════════════════════════════════════════════════════════════

JUPITER_SYSTEM_CONTEXT: str = f"""
════════════════════════════════════════════════════════════════════════════════
JUPITER DEVELOPER PLATFORM — FULL API REFERENCE
Base URL : {JUPITER_BASE_URL}
Auth     : x-api-key header  (process.env.JUPITER_API_KEY)
Portal   : https://developers.jup.ag/portal
llms.txt : https://dev.jup.ag/docs/llms.txt
════════════════════════════════════════════════════════════════════════════════

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
1. SWAP API V2  — unified entry point  https://api.jup.ag/swap/v2
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

TWO PATHS — choose one:

PATH A — Meta-Aggregator  (recommended for most bots)
  All routers compete (Metis + JupiterZ RFQ + Dflow + OKX).
  Jupiter handles transaction landing via /execute.
  Supports gasless swaps, MEV protection, managed retries.

  Step 1 — GET /swap/v2/order
    Required: inputMint, outputMint, amount (base units), taker (wallet pubkey)
    Optional: slippageBps, platformFeeBps, feeAccount, referralAccount,
              referralFee, payer (for gasless), mode (auto|manual)
    Returns : {{ transaction: "<base64>", requestId: "<uuid>", routePlan: [...],
                 inAmount, outAmount, priceImpactPct, contextSlot }}

  Step 2 — POST /swap/v2/execute
    Body    : {{ signedTransaction: "<base64>", requestId: "<uuid>" }}
    Returns : {{ status: "Success"|"Failed", signature: "<txid>",
                 inputAmountResult, outputAmountResult, error? }}

PATH B — Router  (advanced: custom tx, CPI, composability)
  Metis-only routing. Returns raw instructions — you build & send the tx.
  No Jupiter swap fees. No /execute support.

  Step 1 — GET /swap/v2/build
    Required: inputMint, outputMint, amount, taker
    Optional: slippageBps, platformFeeBps, feeAccount, maxAccounts (1-64),
              mode (fast|default)
    Returns : {{ computeBudgetInstructions: [...], setupInstructions: [...],
                 swapInstruction: {{...}}, cleanupInstruction: {{...}},
                 addressLookupTableAddresses: [...], inAmount, outAmount }}

  Step 2 — Assemble tx yourself, sign, then either:
    • connection.sendRawTransaction()  (your own RPC)
    • POST /tx/v1/submit  (Jupiter's landing pipeline, include SOL tip)

GASLESS SWAPS (Meta-Aggregator path only):
  Automatic: Jupiter covers gas when taker has < 0.01 SOL and trade ≥ ~$10.
  Integrator payer: pass  payer=<integrator_pubkey>  in /order or /build.

TYPESCRIPT PATTERN (Meta-Aggregator):
  const orderRes = await fetch(
    \`{JUPITER_BASE_URL}/swap/v2/order?inputMint=${{inputMint}}&outputMint=${{outputMint}}&amount=${{amount}}&taker=${{wallet.publicKey.toBase58()}}\`,
    {{ headers: {{ "x-api-key": process.env.JUPITER_API_KEY ?? "" }} }}
  );
  const {{ transaction, requestId }} = await orderRes.json();

  const tx = VersionedTransaction.deserialize(Buffer.from(transaction, "base64"));
  tx.sign([wallet]);
  const signedTransaction = Buffer.from(tx.serialize()).toString("base64");

  const execRes = await fetch("{JUPITER_BASE_URL}/swap/v2/execute", {{
    method: "POST",
    headers: {{ "Content-Type": "application/json", "x-api-key": process.env.JUPITER_API_KEY ?? "" }},
    body: JSON.stringify({{ signedTransaction, requestId }}),
  }});
  const {{ status, signature }} = await execRes.json();
  // status === "Success" || "Failed"

TYPESCRIPT PATTERN (Router — custom tx with CPI):
  const buildRes = await fetch(
    \`{JUPITER_BASE_URL}/swap/v2/build?inputMint=${{inputMint}}&outputMint=${{outputMint}}&amount=${{amount}}&taker=${{wallet.publicKey.toBase58()}}\`,
    {{ headers: {{ "x-api-key": process.env.JUPITER_API_KEY ?? "" }} }}
  );
  const {{ computeBudgetInstructions, setupInstructions, swapInstruction,
          cleanupInstruction, addressLookupTableAddresses }} = await buildRes.json();
  // Deserialise instructions, compose tx, sign, send via your RPC.


━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
2. TOKENS API V2  — metadata, verification, organic score
   Base: {JUPITER_BASE_URL}/tokens/v2
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  GET /tokens/v2/<mint>           — single token metadata
  GET /tokens/v2/search?query=    — search by name/symbol
  GET /tokens/v2?tags=verified    — filter by tag/category

  Response fields:
    address, name, symbol, decimals, logoURI,
    organicScore (0-100, on-chain trading authenticity),
    verifiedStatus ("verified" | "unverified" | "banned"),
    holderCount, marketCap, volume24h, liquidity,
    tags: ["verified", "community", "strict", "lst", ...]

  Example:
    const res = await fetch(
      "{JUPITER_BASE_URL}/tokens/v2/EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
      {{ headers: {{ "x-api-key": process.env.JUPITER_API_KEY ?? "" }} }}
    );
    const token = await res.json();
    // token.organicScore, token.verifiedStatus, token.volume24h

  USE CASE: before sniping/trading an unknown token, always call this to check
  organicScore > 50 and verifiedStatus === "verified".


━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
3. PRICE API V2  — real-time USD pricing for any Solana token
   Base: {JUPITER_BASE_URL}/price/v2
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  GET /price/v2?ids=<mint1>,<mint2>,...    (up to 100 mints)
  Optional: vsToken=<mint>  (denominator token, default USDC)

  Response: {{ data: {{ "<mint>": {{ id, mintSymbol, vsToken, vsTokenSymbol, price, ... }} }} }}

  Example (fetch SOL + USDC prices):
    const MINTS = [
      "So11111111111111111111111111111111111111112",   // SOL
      "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", // USDC
    ];
    const res = await fetch(
      \`{JUPITER_BASE_URL}/price/v2?ids=${{MINTS.join(",")}}\`,
      {{ headers: {{ "x-api-key": process.env.JUPITER_API_KEY ?? "" }} }}
    );
    const {{ data }} = await res.json();
    const solPrice = parseFloat(data["So11111111111111111111111111111111111111112"].price);

  USE CASE: volatility detection, auto-set trigger orders, P&L calculation.


━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
4. LEND API  — yield, borrowing, flash loans
   Base: {JUPITER_BASE_URL}/lend/v1
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  GET  /lend/v1/markets                   — list all lending markets
  GET  /lend/v1/markets/<market>          — market details (APY, utilization)
  POST /lend/v1/deposit                   — deposit tokens, earn yield
  POST /lend/v1/borrow                    — borrow against collateral
  POST /lend/v1/repay                     — repay borrowed amount
  POST /lend/v1/withdraw                  — withdraw deposited tokens
  POST /lend/v1/flashloan                 — atomic flash loan

  Market response fields:
    marketAddress, tokenMint, supplyAPY, borrowAPY,
    totalDeposits, totalBorrows, utilizationRate, liquidationThreshold

  Flash Loan pattern:
    // 1. POST /lend/v1/flashloan with {{ mint, amount, instructions: [...] }}
    // The instructions execute atomically — repay + fee in same tx.
    // Fee: typically 0.09% of borrowed amount.
    // USE CASE: arbitrage, liquidations, collateral swaps.

  Example (get market APY):
    const res = await fetch("{JUPITER_BASE_URL}/lend/v1/markets",
      {{ headers: {{ "x-api-key": process.env.JUPITER_API_KEY ?? "" }} }}
    );
    const markets = await res.json();
    const usdcMarket = markets.find(m => m.tokenSymbol === "USDC");
    console.log("USDC supply APY:", usdcMarket.supplyAPY);


━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
5. TRIGGER API  — limit orders (single, OCO, OTOCO)
   Base: {JUPITER_BASE_URL}/trigger/v1
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  GET  /trigger/v1/openOrders?userPublicKey=<wallet>       — list open orders
  GET  /trigger/v1/historyOrders?userPublicKey=<wallet>    — order history
  POST /trigger/v1/createOrder                              — place limit order
  POST /trigger/v1/cancelOrder                              — cancel order

  Single limit order body:
    {{
      inputMint: "<mint>",       // sell token
      outputMint: "<mint>",      // buy token
      makingAmount: "<string>",  // base units of inputMint
      takingAmount: "<string>",  // minimum base units of outputMint
      userPublicKey: "<wallet>",
      expiredAt?: <unix_timestamp>
    }}

  OCO (One-Cancels-Other) — take profit + stop loss pair:
    {{
      orderType: "OCO",
      inputMint, outputMint, makingAmount,
      takeProfitRate: "1.15",   // execute when price rises 15%
      stopLossRate:   "0.92",   // execute when price drops 8%
      userPublicKey
    }}

  OTOCO (One-Triggers-OCO) — entry + TP/SL:
    {{
      orderType: "OTOCO",
      inputMint, outputMint, makingAmount,
      entryRate, takeProfitRate, stopLossRate,
      userPublicKey
    }}

  Response: returns a serialised transaction to sign and send.

  TYPESCRIPT PATTERN (place limit order):
    const res = await fetch("{JUPITER_BASE_URL}/trigger/v1/createOrder", {{
      method: "POST",
      headers: {{
        "Content-Type": "application/json",
        "x-api-key": process.env.JUPITER_API_KEY ?? ""
      }},
      body: JSON.stringify({{
        inputMint:     "So11111111111111111111111111111111111111112",
        outputMint:    "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
        makingAmount:  "1000000000",  // 1 SOL
        takingAmount:  "200000000",   // 200 USDC (limit price)
        userPublicKey: wallet.publicKey.toBase58(),
      }}),
    }});
    const {{ transaction }} = await res.json();
    // sign and send transaction

  USE CASE: auto-set limit orders based on Price API volatility signals.


━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
6. RECURRING API  — time-based DCA (Dollar-Cost Averaging)
   Base: {JUPITER_BASE_URL}/recurring/v1
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  GET  /recurring/v1/orders?userPublicKey=<wallet>    — list DCA orders
  POST /recurring/v1/createOrder                       — create DCA order
  POST /recurring/v1/cancelOrder                       — cancel DCA order
  POST /recurring/v1/withdraw                          — withdraw filled order

  Create DCA order body:
    {{
      userPublicKey: "<wallet>",
      inputMint:     "<sell mint>",
      outputMint:    "<buy mint>",
      totalAmount:   "<base units>",   // total to spend over all cycles
      amountPerCycle: "<base units>",  // spend per cycle
      cycleFrequency: <seconds>,       // e.g. 86400 = daily, 3600 = hourly
      minOutAmountPerCycle?: "<units>",
      maxOutAmountPerCycle?: "<units>",
      startAt?: <unix_timestamp>
    }}

  TYPESCRIPT PATTERN (daily DCA 100 USDC → SOL for 7 days):
    const body = {{
      userPublicKey:   wallet.publicKey.toBase58(),
      inputMint:       "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", // USDC
      outputMint:      "So11111111111111111111111111111111111111112",     // SOL
      totalAmount:     "700000000",  // 700 USDC (6 decimals)
      amountPerCycle:  "100000000",  // 100 USDC per cycle
      cycleFrequency:  86400,        // daily
    }};
    const res = await fetch("{JUPITER_BASE_URL}/recurring/v1/createOrder", {{
      method: "POST",
      headers: {{ "Content-Type": "application/json",
                  "x-api-key": process.env.JUPITER_API_KEY ?? "" }},
      body: JSON.stringify(body),
    }});
    const {{ transaction }} = await res.json();
    // sign and send

  USE CASE: DCA strategies that adjust cycle size based on token metadata signals.


━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
7. PREDICTION MARKETS  — binary markets on real-world events
   Base: {JUPITER_BASE_URL}/prediction/v1
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  GET  /prediction/v1/markets          — list active markets
  GET  /prediction/v1/markets/<id>     — market details, odds, volume
  POST /prediction/v1/buy              — buy YES or NO position
  POST /prediction/v1/sell             — sell position
  POST /prediction/v1/redeem           — redeem after resolution

  Market response fields:
    marketId, question, resolutionDate,
    yesPrice (0-1), noPrice (0-1),
    totalVolume, liquidity, status

  Buy position body:
    {{
      marketId:     "<id>",
      side:         "YES" | "NO",
      amount:       "<USDC base units>",
      userPublicKey: "<wallet>",
      slippageBps?: 50
    }}

  TYPESCRIPT PATTERN (buy YES on a market):
    const markets = await (await fetch(
      "{JUPITER_BASE_URL}/prediction/v1/markets",
      {{ headers: {{ "x-api-key": process.env.JUPITER_API_KEY ?? "" }} }}
    )).json();
    const market = markets[0];
    console.log("YES probability:", market.yesPrice * 100, "%");

    const res = await fetch("{JUPITER_BASE_URL}/prediction/v1/buy", {{
      method: "POST",
      headers: {{ "Content-Type": "application/json",
                  "x-api-key": process.env.JUPITER_API_KEY ?? "" }},
      body: JSON.stringify({{
        marketId: market.marketId, side: "YES",
        amount: "10000000",  // 10 USDC
        userPublicKey: wallet.publicKey.toBase58(),
      }}),
    }});
    // sign returned transaction

  USE CASE: AI agent reads prediction market odds and places trades via CLI.


━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
8. PERPS API  — leveraged perpetuals on Solana
   Base: {JUPITER_BASE_URL}/perps/v1
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  GET  /perps/v1/markets                            — list markets (SOL-PERP, BTC-PERP, etc.)
  GET  /perps/v1/positions?userPublicKey=<wallet>   — open positions
  POST /perps/v1/openPosition                       — open leveraged position
  POST /perps/v1/closePosition                      — close position
  POST /perps/v1/addCollateral                      — increase margin
  POST /perps/v1/removeCollateral                   — decrease margin

  Market fields:
    symbol, oraclePrice, fundingRate, openInterest, maxLeverage (up to 100x),
    longLiquidityAvailable, shortLiquidityAvailable

  Open position body:
    {{
      market:       "SOL-PERP",
      side:         "long" | "short",
      collateral:   "<USDC base units>",
      leverage:     5,               // 1-100x
      userPublicKey: "<wallet>",
      slippageBps?:  50
    }}

  TYPESCRIPT PATTERN (open 5x long SOL-PERP):
    const res = await fetch("{JUPITER_BASE_URL}/perps/v1/openPosition", {{
      method: "POST",
      headers: {{ "Content-Type": "application/json",
                  "x-api-key": process.env.JUPITER_API_KEY ?? "" }},
      body: JSON.stringify({{
        market: "SOL-PERP", side: "long",
        collateral: "100000000",  // 100 USDC collateral
        leverage: 5,
        userPublicKey: wallet.publicKey.toBase58(),
      }}),
    }});
    // sign returned transaction


━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
WELL-KNOWN TOKEN MINTS (hardcoded, never guess)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  SOL   : So11111111111111111111111111111111111111112     (9 decimals, wrapped)
  USDC  : EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v  (6 decimals)
  USDT  : Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB   (6 decimals)
  JUP   : JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN   (6 decimals)
  sUSDe : G9W2WBKV3nJULX4kz47HCJ75jnVG4RYWZj5q5U5kXfz   (18 decimals)
  jitoSOL: J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn  (9 decimals)
  mSOL  : mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So   (9 decimals)
  bSOL  : bSo13r4TkiE4KumL71LsHTPpL2euBYLFx6h9HP3piy1   (9 decimals)
  BONK  : DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263  (5 decimals)
  WIF   : EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm  (6 decimals)


━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
CROSS-API COMBINATION PATTERNS (bounty-worthy ideas)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  Pattern A — Volatility-Triggered Limit Orders:
    Price API → detect volatility spike → Trigger API → place OCO order

  Pattern B — Prediction Market Arbitrage Agent:
    Prediction API → read odds → Price API → compare implied vs spot →
    Swap API /order → hedge position if mispricing found

  Pattern C — Flash-Loan Arbitrage:
    Lend API /flashloan → Swap API /build (CPI into loan tx) →
    repay in same atomic transaction → profit

  Pattern D — Adaptive DCA:
    Tokens API → read organicScore + volume24h as signal →
    Recurring API → increase/decrease amountPerCycle dynamically

  Pattern E — Yield Sweeper with Perps Hedge:
    Lend API supplyAPY comparison → Swap API /order to rebalance →
    Perps API short to hedge rebalance slippage risk

  Pattern F — Prediction-Driven Perps:
    Prediction API → read market resolution probability →
    Perps API → open position proportional to odds delta


━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
JUPITER MCP TOOLS  (jupiter-mcp-server, available via callMcpTool in PLANNING)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  search_docs(query)                 — semantic search Jupiter docs
  get_quote(inputMint, outputMint, amount, slippageBps?, swapMode?)
    → returns quoteResponse for Swap V1 (legacy planning reference only)
  get_token_info(mint)               — metadata + safety assessment
  get_price(mints[], vsToken?)       — spot prices via Price V2
  list_trigger_orders(wallet)        — open limit orders
  list_perp_markets()                — available perp markets
  build_swap_transaction(quoteResponse, userPublicKey)
    → base64 tx (legacy; prefer /swap/v2/order for production bots)
  generate_bot_code(strategy, params?) → scaffolded TypeScript

  NOTE: MCP tools are for PLANNING PHASE ONLY.
  Generated bots call Jupiter REST APIs directly via axios/fetch.
  Never import callMcpTool() in generated bot code.


━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
ENV VARS  (required in generated bot .env)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  JUPITER_API_KEY       — from developers.jup.ag/portal  (x-api-key header)
  JUPITER_BASE_URL      — https://api.jup.ag  (default, can override)
  SOLANA_RPC_URL        — your RPC endpoint
  SOLANA_KEY            — wallet keypair JSON byte array
  USER_WALLET_ADDRESS   — wallet public key
  SIMULATION_MODE       — true|false  (default true)
  POLL_INTERVAL_MS      — polling interval (default 60000)

════════════════════════════════════════════════════════════════════════════════
"""

# ══════════════════════════════════════════════════════════════════════════════
# Per-strategy context builders
# ══════════════════════════════════════════════════════════════════════════════

_STRATEGY_APIS: dict[str, list[str]] = {
    "yield_sweeper":    ["swap_v2", "lend", "price", "tokens"],
    "arbitrage":        ["swap_v2", "lend", "price"],
    "sniping":          ["swap_v2", "tokens", "price"],
    "dca":              ["recurring", "tokens", "price"],
    "liquidation":      ["swap_v2", "lend", "price"],
    "grid":             ["swap_v2", "trigger", "price"],
    "whale_mirror":     ["swap_v2", "tokens", "price"],
    "sentiment":        ["swap_v2", "prediction", "tokens", "price"],
    "custom_utility":   ["swap_v2", "tokens", "price"],
    "prediction_arb":   ["prediction", "swap_v2", "price"],
    "perps":            ["perps", "price", "swap_v2"],
    "flash_arb":        ["lend", "swap_v2", "price"],
    "trigger_bot":      ["trigger", "price", "tokens"],
    "adaptive_dca":     ["recurring", "tokens", "price"],
}


def get_strategy_apis(strategy: str) -> list[str]:
    """Return the list of Jupiter API product names needed for a given strategy."""
    return _STRATEGY_APIS.get(strategy, ["swap_v2", "tokens", "price"])


def build_jupiter_env_block(extra_vars: Optional[dict] = None) -> str:
    """Return a .env snippet with Jupiter credentials pre-populated."""
    lines = [
        f"JUPITER_API_KEY={JUPITER_API_KEY}",
        f"JUPITER_BASE_URL={JUPITER_BASE_URL}",
    ]
    if extra_vars:
        for k, v in extra_vars.items():
            lines.append(f"{k}={v}")
    return "\n".join(lines)


async def build_jupiter_user_context(
    strategy: str = "custom_utility",
    tokens: Optional[list[str]] = None,
) -> str:
    """
    Build a per-request Jupiter context string for injection into the LLM user message.
    Fetches live data from the Jupiter MCP server if available, otherwise returns static context.

    Args:
        strategy:  the bot strategy (used to filter which API sections to include)
        tokens:    optional list of token mints to fetch live prices for

    Returns:
        A markdown-formatted context string ready for LLM injection.
    """
    apis = get_strategy_apis(strategy)
    sections: list[str] = [
        f"=== JUPITER CONTEXT (strategy: {strategy}) ===",
        f"APIs needed: {', '.join(apis)}",
        f"Base URL: {JUPITER_BASE_URL}",
        f"Auth: x-api-key header from JUPITER_API_KEY env var",
        "",
    ]

    if "swap_v2" in apis:
        sections.append(
            "SWAP: Use GET /swap/v2/order + POST /swap/v2/execute (Meta-Aggregator, best price).\n"
            "For custom tx/CPI: GET /swap/v2/build then sign and send yourself.\n"
            "Both require: inputMint, outputMint, amount (base units), taker (wallet pubkey)."
        )

    if "lend" in apis:
        sections.append(
            "LEND: GET /lend/v1/markets for APY data. "
            "POST /lend/v1/flashloan for flash loans (atomic, same-tx repay). "
            "Fee: ~0.09% of borrowed amount."
        )

    if "trigger" in apis:
        sections.append(
            "TRIGGER: POST /trigger/v1/createOrder for limit orders. "
            "Supports single, OCO (TP+SL), OTOCO (entry+TP+SL). "
            "GET /trigger/v1/openOrders?userPublicKey=<wallet> to check existing orders."
        )

    if "recurring" in apis:
        sections.append(
            "RECURRING (DCA): POST /recurring/v1/createOrder. "
            "Fields: totalAmount, amountPerCycle, cycleFrequency (seconds). "
            "GET /recurring/v1/orders?userPublicKey=<wallet> to monitor."
        )

    if "prediction" in apis:
        sections.append(
            "PREDICTION MARKETS: GET /prediction/v1/markets for active binary markets. "
            "POST /prediction/v1/buy with side=YES|NO to trade. "
            "yesPrice/noPrice are 0-1 implied probabilities."
        )

    if "perps" in apis:
        sections.append(
            "PERPS: GET /perps/v1/markets for SOL-PERP, BTC-PERP, etc. "
            "POST /perps/v1/openPosition with market, side (long|short), collateral, leverage."
        )

    if "tokens" in apis:
        sections.append(
            "TOKENS: GET /tokens/v2/<mint> for metadata, organicScore, verifiedStatus. "
            "Always check organicScore > 50 and verifiedStatus === 'verified' before trading."
        )

    if "price" in apis:
        sections.append(
            "PRICE: GET /price/v2?ids=<mint1>,<mint2> for real-time USD prices. "
            "Use for volatility detection, entry/exit thresholds, P&L calculation."
        )

    sections.append(
        "\nENV VARS: JUPITER_API_KEY, JUPITER_BASE_URL, SOLANA_RPC_URL, "
        "SOLANA_KEY, USER_WALLET_ADDRESS, SIMULATION_MODE, POLL_INTERVAL_MS"
    )

    return "\n".join(sections)


# ══════════════════════════════════════════════════════════════════════════════
# MCP tool descriptions (injected into planning phase prompts)
# ══════════════════════════════════════════════════════════════════════════════

def get_mcp_tool_descriptions() -> str:
    """Return a compact description of all Jupiter MCP tools for planner injection."""
    return """
JUPITER MCP SERVER TOOLS (available during planning — DO NOT use at bot runtime):
  search_docs(query)                    — search Jupiter API docs
  get_quote(inputMint, outputMint, amount, slippageBps?, swapMode?)
  get_token_info(mint)                  — token metadata + safety check
  get_price(mints[], vsToken?)          — current USD prices
  list_trigger_orders(wallet)           — open limit orders
  list_perp_markets()                   — available perp markets
  build_swap_transaction(quoteResponse, userPublicKey)
  generate_bot_code(strategy, params?)  — scaffolded TypeScript template

IMPORTANT: These tools call live APIs.  Results are for PLANNING ONLY.
The generated bot code must call Jupiter REST APIs directly via axios/fetch.
""".strip()


# ══════════════════════════════════════════════════════════════════════════════
# Docs JSON entries for jupiter-mcp-server/docs.json  (call write_docs_json())
# ══════════════════════════════════════════════════════════════════════════════

JUPITER_DOCS_ENTRIES: list[dict] = [
    {
        "id": "swap_v2_order",
        "title": "Swap V2 — Meta-Aggregator (/order + /execute)",
        "keywords": ["swap", "order", "execute", "meta-aggregator", "v2", "swap_v2"],
        "schema": (
            "// GET /swap/v2/order?inputMint=<mint>&outputMint=<mint>&amount=<units>&taker=<wallet>\n"
            "// Headers: { 'x-api-key': JUPITER_API_KEY }\n"
            "// Returns: { transaction: '<base64>', requestId: '<uuid>', inAmount, outAmount, routePlan }\n\n"
            "// POST /swap/v2/execute  Body: { signedTransaction: '<base64>', requestId: '<uuid>' }\n"
            "// Returns: { status: 'Success'|'Failed', signature: '<txid>' }"
        ),
        "example": (
            "const orderRes = await axios.get(`${JUPITER_BASE_URL}/swap/v2/order`, {\n"
            "  params: { inputMint, outputMint, amount: amount.toString(), taker: wallet.publicKey.toBase58() },\n"
            "  headers: { 'x-api-key': process.env.JUPITER_API_KEY },\n"
            "});\n"
            "const tx = VersionedTransaction.deserialize(Buffer.from(orderRes.data.transaction, 'base64'));\n"
            "tx.sign([wallet]);\n"
            "const execRes = await axios.post(`${JUPITER_BASE_URL}/swap/v2/execute`, {\n"
            "  signedTransaction: Buffer.from(tx.serialize()).toString('base64'),\n"
            "  requestId: orderRes.data.requestId,\n"
            "}, { headers: { 'x-api-key': process.env.JUPITER_API_KEY } });\n"
            "console.log('Status:', execRes.data.status, 'Sig:', execRes.data.signature);"
        ),
    },
    {
        "id": "swap_v2_build",
        "title": "Swap V2 — Router (/build) for custom transactions",
        "keywords": ["swap", "build", "router", "cpi", "instructions", "v2"],
        "schema": (
            "// GET /swap/v2/build?inputMint=<mint>&outputMint=<mint>&amount=<units>&taker=<wallet>\n"
            "// Returns: { computeBudgetInstructions, setupInstructions, swapInstruction,\n"
            "//            cleanupInstruction, addressLookupTableAddresses, inAmount, outAmount }\n"
            "// Metis-only routing. No Jupiter swap fees. /execute NOT available."
        ),
        "example": (
            "const { data } = await axios.get(`${JUPITER_BASE_URL}/swap/v2/build`, {\n"
            "  params: { inputMint, outputMint, amount: amount.toString(), taker: wallet.toBase58() },\n"
            "  headers: { 'x-api-key': process.env.JUPITER_API_KEY },\n"
            "});\n"
            "// Assemble tx from data.computeBudgetInstructions + data.setupInstructions\n"
            "// + data.swapInstruction + data.cleanupInstruction\n"
            "// Then sign and send via connection.sendRawTransaction()"
        ),
    },
    {
        "id": "tokens_v2",
        "title": "Tokens API V2 — metadata, verification, organic score",
        "keywords": ["token", "tokens", "metadata", "organic", "score", "verify", "verified"],
        "schema": (
            "// GET /tokens/v2/<mint>\n"
            "// Returns: { address, name, symbol, decimals, logoURI,\n"
            "//   organicScore (0-100), verifiedStatus ('verified'|'unverified'|'banned'),\n"
            "//   holderCount, marketCap, volume24h, liquidity, tags }"
        ),
        "example": (
            "const { data } = await axios.get(\n"
            "  `${JUPITER_BASE_URL}/tokens/v2/${mint}`,\n"
            "  { headers: { 'x-api-key': process.env.JUPITER_API_KEY } }\n"
            ");\n"
            "if (data.verifiedStatus !== 'verified' || data.organicScore < 50) {\n"
            "  console.warn('Risky token, skipping');\n"
            "  return;\n"
            "}"
        ),
    },
    {
        "id": "price_v2",
        "title": "Price API V2 — real-time USD token prices",
        "keywords": ["price", "usd", "pricing", "spot", "price_v2"],
        "schema": (
            "// GET /price/v2?ids=<mint1>,<mint2>,...&vsToken=<mint>\n"
            "// Returns: { data: { '<mint>': { id, mintSymbol, vsToken, price } } }"
        ),
        "example": (
            "const { data } = await axios.get(`${JUPITER_BASE_URL}/price/v2`, {\n"
            "  params: { ids: [SOL_MINT, USDC_MINT].join(',') },\n"
            "  headers: { 'x-api-key': process.env.JUPITER_API_KEY },\n"
            "});\n"
            "const solPrice = parseFloat(data.data[SOL_MINT].price);"
        ),
    },
    {
        "id": "lend_v1",
        "title": "Lend API V1 — yield, borrowing, flash loans",
        "keywords": ["lend", "lending", "flashloan", "flash", "loan", "borrow", "apy", "yield"],
        "schema": (
            "// GET  /lend/v1/markets  → [{ marketAddress, tokenMint, supplyAPY, borrowAPY, ... }]\n"
            "// POST /lend/v1/deposit  body: { mint, amount, userPublicKey }\n"
            "// POST /lend/v1/flashloan body: { mint, amount, instructions: [...], userPublicKey }"
        ),
        "example": (
            "const { data: markets } = await axios.get(`${JUPITER_BASE_URL}/lend/v1/markets`,\n"
            "  { headers: { 'x-api-key': process.env.JUPITER_API_KEY } });\n"
            "const usdc = markets.find(m => m.tokenSymbol === 'USDC');\n"
            "console.log('USDC supply APY:', usdc.supplyAPY, '% | borrow APY:', usdc.borrowAPY, '%');"
        ),
    },
    {
        "id": "trigger_v1",
        "title": "Trigger API V1 — limit orders (single, OCO, OTOCO)",
        "keywords": ["trigger", "limit", "order", "oco", "otoco", "stop", "take-profit", "stop-loss"],
        "schema": (
            "// POST /trigger/v1/createOrder\n"
            "// body: { inputMint, outputMint, makingAmount, takingAmount, userPublicKey,\n"
            "//         orderType?: 'OCO'|'OTOCO', takeProfitRate?, stopLossRate?, entryRate? }\n"
            "// GET  /trigger/v1/openOrders?userPublicKey=<wallet>\n"
            "// POST /trigger/v1/cancelOrder  body: { orderId, userPublicKey }"
        ),
        "example": (
            "const { data } = await axios.post(`${JUPITER_BASE_URL}/trigger/v1/createOrder`, {\n"
            "  inputMint: SOL_MINT, outputMint: USDC_MINT,\n"
            "  makingAmount: '1000000000',  // 1 SOL\n"
            "  takingAmount: '200000000',   // 200 USDC limit price\n"
            "  userPublicKey: wallet.publicKey.toBase58(),\n"
            "}, { headers: { 'x-api-key': process.env.JUPITER_API_KEY } });\n"
            "// sign data.transaction"
        ),
    },
    {
        "id": "recurring_v1",
        "title": "Recurring API V1 — time-based DCA",
        "keywords": ["recurring", "dca", "dollar-cost", "averaging", "periodic", "schedule"],
        "schema": (
            "// POST /recurring/v1/createOrder\n"
            "// body: { userPublicKey, inputMint, outputMint, totalAmount, amountPerCycle,\n"
            "//         cycleFrequency (seconds), minOutAmountPerCycle?, maxOutAmountPerCycle?, startAt? }\n"
            "// GET  /recurring/v1/orders?userPublicKey=<wallet>\n"
            "// POST /recurring/v1/cancelOrder  body: { orderId, userPublicKey }"
        ),
        "example": (
            "const { data } = await axios.post(`${JUPITER_BASE_URL}/recurring/v1/createOrder`, {\n"
            "  userPublicKey: wallet.publicKey.toBase58(),\n"
            "  inputMint: USDC_MINT, outputMint: SOL_MINT,\n"
            "  totalAmount: '700000000',   // 700 USDC total\n"
            "  amountPerCycle: '100000000', // 100 USDC/cycle\n"
            "  cycleFrequency: 86400,       // daily\n"
            "}, { headers: { 'x-api-key': process.env.JUPITER_API_KEY } });\n"
            "// sign data.transaction"
        ),
    },
    {
        "id": "prediction_v1",
        "title": "Prediction Markets V1 — binary markets on real-world events",
        "keywords": ["prediction", "market", "binary", "yes", "no", "odds", "resolve"],
        "schema": (
            "// GET  /prediction/v1/markets  → [{ marketId, question, yesPrice, noPrice, resolutionDate }]\n"
            "// POST /prediction/v1/buy  body: { marketId, side: 'YES'|'NO', amount, userPublicKey }\n"
            "// POST /prediction/v1/sell body: { marketId, positionId, amount, userPublicKey }\n"
            "// POST /prediction/v1/redeem body: { marketId, userPublicKey }  (after resolution)"
        ),
        "example": (
            "const { data: markets } = await axios.get(`${JUPITER_BASE_URL}/prediction/v1/markets`,\n"
            "  { headers: { 'x-api-key': process.env.JUPITER_API_KEY } });\n"
            "const hot = markets.filter(m => m.yesPrice > 0.7 && m.totalVolume > 100000);\n"
            "console.log('High-confidence YES markets:', hot.map(m => m.question));"
        ),
    },
    {
        "id": "perps_v1",
        "title": "Perps API V1 — leveraged perpetuals",
        "keywords": ["perps", "perpetuals", "leverage", "long", "short", "position", "margin"],
        "schema": (
            "// GET  /perps/v1/markets  → [{ symbol, oraclePrice, fundingRate, maxLeverage }]\n"
            "// GET  /perps/v1/positions?userPublicKey=<wallet>\n"
            "// POST /perps/v1/openPosition  body: { market, side, collateral, leverage, userPublicKey }\n"
            "// POST /perps/v1/closePosition body: { positionId, userPublicKey }"
        ),
        "example": (
            "const { data } = await axios.post(`${JUPITER_BASE_URL}/perps/v1/openPosition`, {\n"
            "  market: 'SOL-PERP', side: 'long',\n"
            "  collateral: '100000000',  // 100 USDC\n"
            "  leverage: 5,\n"
            "  userPublicKey: wallet.publicKey.toBase58(),\n"
            "}, { headers: { 'x-api-key': process.env.JUPITER_API_KEY } });\n"
            "// sign data.transaction"
        ),
    },
    {
        "id": "flashloan_arbitrage",
        "title": "Flash Loan + Swap Arbitrage Pattern",
        "keywords": ["flashloan", "flash", "loan", "arbitrage", "arb", "atomic", "profit"],
        "schema": (
            "// Chain: Lend /flashloan → Swap /build (CPI) → repay in same tx\n"
            "// 1. GET /swap/v2/build for the arbitrage swap instructions\n"
            "// 2. POST /lend/v1/flashloan with those instructions embedded\n"
            "// 3. Sign the combined transaction → atomic execution"
        ),
        "example": (
            "// Step 1: get raw swap instructions\n"
            "const { data: buildData } = await axios.get(`${JUPITER_BASE_URL}/swap/v2/build`, {\n"
            "  params: { inputMint: TOKEN_A, outputMint: TOKEN_B, amount: loanAmount, taker: wallet.toBase58() },\n"
            "  headers: { 'x-api-key': process.env.JUPITER_API_KEY },\n"
            "});\n"
            "// Step 2: embed in flash loan\n"
            "const { data: loanData } = await axios.post(`${JUPITER_BASE_URL}/lend/v1/flashloan`, {\n"
            "  mint: TOKEN_A, amount: loanAmount,\n"
            "  instructions: [buildData.swapInstruction],\n"
            "  userPublicKey: wallet.publicKey.toBase58(),\n"
            "}, { headers: { 'x-api-key': process.env.JUPITER_API_KEY } });\n"
            "// sign loanData.transaction"
        ),
    },
    {
        "id": "bot_template_arbitrage",
        "title": "Arbitrage Bot Template",
        "keywords": ["arbitrage", "arb", "spread", "profit", "arbitrage_bot"],
        "schema": (
            "// Strategy: detect price discrepancies, execute swap for profit\n"
            "// APIs: Price V2 (monitor) + Swap V2 /order (execute)\n"
            "// Optional: Lend /flashloan for capital-efficient arb"
        ),
    },
    {
        "id": "bot_template_yield_sweeper",
        "title": "Yield Sweeper Bot Template",
        "keywords": ["yield", "sweeper", "kamino", "susde", "apy", "rebalance"],
        "schema": (
            "// Strategy: compare lending APYs, swap to highest yield token\n"
            "// APIs: Lend V1 (APY) + Swap V2 /order (rebalance) + Price V2 (monitor)"
        ),
    },
    {
        "id": "bot_template_dca",
        "title": "DCA Bot Template",
        "keywords": ["dca", "dollar", "cost", "averaging", "periodic", "recurring"],
        "schema": (
            "// Strategy: systematic buys using Recurring API\n"
            "// APIs: Recurring V1 (createOrder) + Tokens V2 (signal) + Price V2 (entry threshold)"
        ),
    },
    {
        "id": "bot_template_copy_trade",
        "title": "Copy Trade Bot Template",
        "keywords": ["copy", "trade", "whale", "mirror", "copy_trade"],
        "schema": (
            "// Strategy: monitor whale wallet, mirror their swaps\n"
            "// APIs: Solana RPC (watch wallet) + Tokens V2 (verify) + Swap V2 /order (mirror)"
        ),
    },
    {
        "id": "bot_template_safe_sniper",
        "title": "Safe Sniper Bot Template",
        "keywords": ["sniper", "snipe", "safe_sniper", "launch", "new token"],
        "schema": (
            "// Strategy: snipe new token launches with safety checks\n"
            "// APIs: Tokens V2 (organicScore + verifiedStatus) + Swap V2 /order (execute)"
        ),
    },
    {
        "id": "bot_template_prediction",
        "title": "Prediction Market Trader Bot Template",
        "keywords": ["prediction", "market", "binary", "odds", "event"],
        "schema": (
            "// Strategy: read prediction market odds, trade if mispriced\n"
            "// APIs: Prediction V1 (markets) + Price V2 (anchor) + Swap V2 /order (hedge)"
        ),
    },
    {
        "id": "bot_template_perps",
        "title": "Perps Trading Bot Template",
        "keywords": ["perps", "perpetual", "leverage", "long", "short", "event_driven"],
        "schema": (
            "// Strategy: open leveraged positions based on signals\n"
            "// APIs: Perps V1 (openPosition) + Price V2 (entry signal) + Trigger V1 (TP/SL)"
        ),
    },
]


def write_docs_json(output_path: Optional[str] = None) -> str:
    """
    Serialise JUPITER_DOCS_ENTRIES to a docs.json file for the MCP server.

    Args:
        output_path: path to write the file (default: agents/jupiter-mcp-server/docs.json)

    Returns:
        The path written to.
    """
    import json

    if output_path is None:
        output_path = str(
            _BASE_DIR / "jupiter-mcp-server" / "docs.json"
        )

    with open(output_path, "w", encoding="utf-8") as fh:
        json.dump(JUPITER_DOCS_ENTRIES, fh, indent=2)

    print(f"[jupiter_prompt] Wrote {len(JUPITER_DOCS_ENTRIES)} doc entries → {output_path}")
    return output_path


# ══════════════════════════════════════════════════════════════════════════════
# CLI entry-point: python jupiter_prompt.py
# ══════════════════════════════════════════════════════════════════════════════

if __name__ == "__main__":
    import argparse, json, sys

    parser = argparse.ArgumentParser(
        description="Jupiter prompt utilities for the Agentia meta-agent"
    )
    sub = parser.add_subparsers(dest="cmd")

    sub.add_parser("docs", help="Write docs.json for jupiter-mcp-server")
    sub.add_parser("context", help="Print the full JUPITER_SYSTEM_CONTEXT")
    sub.add_parser("env", help="Print a .env snippet with Jupiter credentials")

    ctx_cmd = sub.add_parser("strategy", help="Print per-strategy context")
    ctx_cmd.add_argument("strategy", help="e.g. yield_sweeper, arbitrage, dca")

    args = parser.parse_args()

    if args.cmd == "docs":
        path = write_docs_json()
        print(f"Done: {path}")

    elif args.cmd == "context":
        print(JUPITER_SYSTEM_CONTEXT)

    elif args.cmd == "env":
        print(build_jupiter_env_block())

    elif args.cmd == "strategy":
        import asyncio
        ctx = asyncio.run(build_jupiter_user_context(strategy=args.strategy))
        print(ctx)

    else:
        parser.print_help()
        sys.exit(1)