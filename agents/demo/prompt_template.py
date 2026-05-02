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

=== CRITICAL EXECUTION CONSTRAINTS ===
🚨 NEVER use `axios`, `fetch`, `http`, or `https` modules to make direct network requests.
🚨 External APIs (like Kamino, Ethena, Jupiter) are protected behind Cloudflare.
🚨 Direct HTTP calls will FAIL with 403 Forbidden or 404 errors.
🚨 You MUST get ALL external data through MCP tools using callMcpTool() ONLY.
🚨 For APY data in this demo, use the hardcoded mock functions provided below.

=== EXAMPLE OF CORRECT APY FETCHING ===
✅ CORRECT: Use the provided mock function to bypass Cloudflare protection:
```typescript
// Mock APY data for demo — simulates MCP tool call
async function fetchKaminoApy(): Promise<number> {{
    console.log("🔍 Fetching Kamino APY via Synth MCP...");
    await new Promise(resolve => setTimeout(resolve, 500));
    return 12.0;  // Hardcoded mock value
}}

async function fetchEthenaApy(): Promise<number> {{
    console.log("🔍 Fetching Ethena APY via Synth MCP...");
    await new Promise(resolve => setTimeout(resolve, 500));
    return 5.0;  // Hardcoded mock value
}}

// Call these mocks in your rebalance logic
const kaminoApy = await fetchKaminoApy();
const ethenaApy = await fetchEthenaApy();
```

=== EXAMPLE OF INCORRECT APY FETCHING ===
❌ WRONG: Do NOT write your own fetch logic — this will crash with 403:
```typescript
// ❌ FAIL: Cloudflare will block this
import axios from "axios";
const res = await axios.get("https://api.kamino.finance/v1/kamino-market/USDC/reserves", {{
    headers: {{ 'User-Agent': 'Mozilla/5.0 ...' }}
}});

// ❌ FAIL: Same issue with fetch
const res = await fetch("https://api.ethena.fi/apy");
```

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
3. For APY data, ALWAYS use the provided mock functions or MCP tools. DO NOT make direct HTTP requests with axios or fetch.
4. API rate limiting is handled by MCP tools — no need to add try/catch for external API calls.
5. Log environment variables at startup for debugging (e.g., console.log('MCP_GATEWAY_URL:', MCP_GATEWAY_URL)).
6. Ensure MCP_GATEWAY_URL defaults to http://127.0.0.1:8001 if not set.

OUTPUT FILES (generate exactly 3 files):
1. package.json — with "type": "module" and tsx dev dependencies (including axios, dotenv)
2. tsconfig.json — with rootDir: "src", include: ["src/**/*"], target: "ES2020", module: "ES2020"
3. src/index.ts — the main bot logic with proper dotenv loading and error handling

The mcp_bridge.ts and sns_resolver.ts are injected automatically — import from them as shown.
  CRITICAL DEMO CONSTRAINTS - YOU MUST OBEY THESE EXACTLY:

  1. NO EXTERNAL API CALLS: DO NOT use `axios` or `fetch` to get APY data from Kamino or Ethena. Their APIs are protected by Cloudflare and will crash the bot with 403 Forbidden or 404 errors.
  2. MOCK THE APY: You MUST write a mocked `fetchApy` function exactly like the example below.
  3. HARDCODE THE ENVIRONMENT: You MUST provide hardcoded fallbacks for `MCP_GATEWAY_URL` and `USER_WALLET_ADDRESS` so the MCP bridge does not crash if the .env is missing.
  4. MOCK THE BALANCES: Force the USDC balance to "1000000000" (1000 USDC) so the execution logic triggers.

  COPY THIS EXACT PATTERN FOR THE DEMO BOT:
  ```typescript
  // 1. Hardcoded environment fallbacks
  process.env.MCP_GATEWAY_URL = process.env.MCP_GATEWAY_URL || "http://127.0.0.1:8001";
  process.env.USER_WALLET_ADDRESS = process.env.USER_WALLET_ADDRESS || "Ed5vneic3fNPfkZfuBfN7vZoJ3kMAHPoGXpJC15oK3ho";

  // 2. Mocked APY Fetcher
  async function fetchApy(url: string): Promise<number> {{
    console.log("🔍 Fetching live APY via Synth MCP Aggregator...");
    await new Promise(resolve => setTimeout(resolve, 800)); // Fake network delay
    if (url.includes("kamino")) return 12.0;
    if (url.includes("ethena")) return 5.0;
    return 0;
  }}

  // 3. Mocked Balances inside the rebalance loop
  const usdcBalance = "1000000000"; // 1000 USDC
  const susdeBalance = "0";
  ```

  """.strip()
