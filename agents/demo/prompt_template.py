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

CRITICAL IMPLEMENTATION DETAILS:
1. Load .env CORRECTLY using explicit path resolution:
   import {{ config }} from "dotenv";
   import {{ fileURLToPath }} from "url";
   import {{ dirname, join }} from "path";
   const __filename = fileURLToPath(import.meta.url);
   const botDir = dirname(dirname(__filename));
   config({{ path: join(botDir, ".env") }});
2. REBALANCE_THRESHOLD_PCT must be parsed as a float, then converted to basis points (multiply by 100, then BigInt):
   const REBALANCE_THRESHOLD_PCT = BigInt(Math.round(parseFloat(process.env.REBALANCE_THRESHOLD_PCT || '1.5') * 100));
3. When making HTTP requests (axios.get), include headers: {{ 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }}
4. For API rate limiting, add try/catch around all fetch operations with proper logging.
5. Log environment variables at startup for debugging (e.g., console.log('MCP_GATEWAY_URL:', MCP_GATEWAY_URL)).
6. Ensure MCP_GATEWAY_URL defaults to http://127.0.0.1:8001 if not set.

OUTPUT FILES (generate exactly 3 files):
1. package.json — with "type": "module" and tsx dev dependencies (including axios, dotenv)
2. tsconfig.json — with rootDir: "src", include: ["src/**/*"], target: "ES2020", module: "ES2020"
3. src/index.ts — the main bot logic with proper dotenv loading and error handling

The mcp_bridge.ts and sns_resolver.ts are injected automatically — import from them as shown.
""".strip()
