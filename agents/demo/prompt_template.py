"""
agents/demo/prompt_template.py

Builds a fully-specified bot prompt with all token mints,
MCP endpoints, and strategy injected — no LLM guessing.
"""

import json
from pathlib import Path

CONFIG = json.loads(
    (Path(__file__).parent / "config.json").read_text()
)


def build_prompt() -> str:
    t = CONFIG["tokens"]
    return f"""
You are an expert Solana TypeScript engineer building a production yield sweeper bot.

STRATEGY: Autonomous USDC yield sweeping between Kamino and sUSDe (via Jupiter swaps).

EXACT TOKEN MINTS — use these verbatim, never guess:
  USDC:   {t["USDC_MINT"]}
  sUSDe:  {t["SUSDE_MINT"]}
  SOL:    {t["SOL_MINT"]}

MCP GATEWAY: {CONFIG["mcpGatewayUrl"]}
JUPITER MCP: {CONFIG["jupiterMcpUrl"]}

EXECUTION RULES:
1. NEVER write raw Solana transactions or use @solana/web3.js directly.
2. ALL swaps go through Jupiter MCP tool: callMcpTool("jupiter", "execute_swap", {{
     inputMint, outputMint, amount, userWallet, slippageBps: 50
   }})
3. To DEPOSIT to Kamino: swap USDC → sUSDe via Jupiter.
4. To WITHDRAW from Kamino: swap sUSDe → USDC via Jupiter.
5. Read USDC balance: callMcpTool("solana", "get_token_balance", {{
     network, owner: WALLET, mint: "{t["USDC_MINT"]}"
   }})
6. Read sUSDe balance: callMcpTool("solana", "get_token_balance", {{
     network, owner: WALLET, mint: "{t["SUSDE_MINT"]}"
   }})
7. Fetch Kamino APY from: https://api.kamino.finance/v1/kamino-market/USDC/reserves
8. Fetch sUSDe APY from: https://api.ethena.fi/apy (HTTPS, parse .apy field)
9. REBALANCE when: sUSDe_apy - kamino_apy >= {CONFIG["thresholdPct"]}% (enter sUSDe)
                   OR kamino_apy - sUSDe_apy >= {CONFIG["thresholdPct"]}% (exit to Kamino)
10. Poll every {CONFIG["pollIntervalMs"]}ms using setInterval.
11. SIMULATION_MODE = process.env.SIMULATION_MODE !== "false" (default true).
12. Use BigInt for all token amounts. USDC has 6 decimals, sUSDe has 18 decimals.
13. Guard with inFlight boolean to prevent overlapping cycles.
14. Handle SIGINT/SIGTERM with graceful shutdown (clearInterval).

REQUIRED ENV VARS (bot must read these, never hardcode):
  SOLANA_NETWORK, SOLANA_KEY, USER_WALLET_ADDRESS,
  MCP_GATEWAY_URL, SIMULATION_MODE, POLL_INTERVAL_MS,
  KAMINO_APY_URL, SUSDE_APY_URL, REBALANCE_THRESHOLD_PCT

Generate exactly 2 files: package.json and src/index.ts.
The mcp_bridge.ts and sns_resolver.ts are injected automatically — import from them as shown.
""".strip()
