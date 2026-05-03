"""
agents/generate.py

Generate a Solana bot prompt and send it to the Meta-Agent for scaffold generation.

Usage:
    python generate.py
    python generate.py --config '{"chain":"solana-devnet","botName":"My Solana Bot"}'
    python generate.py --config-file my_config.json
"""

import argparse
import json
import os
from datetime import datetime
from pathlib import Path

import requests

DEFAULT_CONFIG = {
    "botName": "Cross-Rollup Yield Sweeper",
    "chain": "solana-mainnet",
    "baseToken": "USDC",
    "targetToken": "USDC",
    "dex": "solana",
    "securityProvider": "none",
    "borrowAmountHuman": 1,
    "minProfitUsd": 0.0,
    "gasBufferUsdc": 0,
    "pollingIntervalSec": 15,
    "simulationMode": True,
    "dataProvider": "goldrush",
    "privateExecution": False,
    "maxRiskScore": 20,
}

CHAIN_IDS = {
    "solana-mainnet": "mainnet-beta",
    "solana-devnet": "devnet",
}

TOKEN_DENOMS = {
    "USDC": {"solana-mainnet": "USDC", "solana-devnet": "USDC"},
    "SOL": {"solana-mainnet": "SOL", "solana-devnet": "SOL"},
}


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Generate a Solana bot")
    parser.add_argument("--demo", action="store_true", help="Use the demo/config.json template (yield sweeper with exact mints)")
    parser.add_argument("--strategy", type=str, help="Optional strategy override (arbitrage, yield_sweeper, etc.)")
    group = parser.add_mutually_exclusive_group()
    group.add_argument("--config", type=str, help="JSON string of bot configuration")
    group.add_argument("--config-file", type=str, help="Path to a JSON config file")
    return parser.parse_args()


def load_config(args: argparse.Namespace) -> dict:
    config = dict(DEFAULT_CONFIG)
    if getattr(args, 'strategy', None):
        config['strategy'] = args.strategy
    if args.config:
        try:
            config.update(json.loads(args.config))
        except json.JSONDecodeError as exc:
            print(f"Invalid JSON in --config: {exc}")
            raise SystemExit(1)
    elif args.config_file:
        try:
            with open(args.config_file, "r", encoding="utf-8") as handle:
                config.update(json.load(handle))
        except (OSError, json.JSONDecodeError) as exc:
            print(f"Could not read {args.config_file}: {exc}")
            raise SystemExit(1)

    if str(config.get("chain", "")).strip().lower() not in CHAIN_IDS:
        config["chain"] = "solana-mainnet"
    return config


def build_prompt(config: dict) -> str:
    chain = str(config.get("chain", "solana-mainnet")).strip().lower()
    chain_id = CHAIN_IDS[chain]
    base_token = str(config.get("baseToken", "USDC")).strip().upper()
    quote_token = str(config.get("targetToken", "USDC")).strip().upper()
    base_denom = TOKEN_DENOMS.get(base_token, {}).get(chain, "USDC")
    quote_denom = TOKEN_DENOMS.get(quote_token, {}).get(chain, "USDC")

    return f"""
You are an expert TypeScript and Solana-oriented bot engineer.
Generate a Solana-native bot.

CONFIGURATION:
- Bot Name: {config.get("botName", "Solana Bot")}
- Chain: {chain} (Network ID: {chain_id})
- Base denom: {base_token} ({base_denom})
- Quote denom: {quote_token} ({quote_denom})
- Poll every: {config.get("pollingIntervalSec", 15)} seconds
- Simulation mode default: {"true" if config.get("simulationMode", True) else "false"}
- Data provider: {config.get("dataProvider", "goldrush")}
- Private execution: {"true" if config.get("privateExecution", False) else "false"}

RULES:
1. Use TypeScript only.
2. Use the provided `solana_utils.ts` and Solana web3 SDK for on-chain interactions.
3. For RPC/MCP interactions, prefer `callMcpTool('solana', ...)` or direct Solana RPC calls when needed.
4. All on-chain amounts must use `BigInt`.
5. Read token balances via SPL token helper functions and sign/send transactions via Solana web3.
6. Environment variables must use the `SOLANA_` prefix (e.g., `SOLANA_RPC_URL`, `SOLANA_KEY`).
7. For yield sweeper behavior, observe SPL token balances and call bridge/sweep helpers when thresholds are met.
8. Avoid Move-specific terminology (move_view/move_execute); generate Solana-native code.
9. Keep runtime Solana-native and avoid Move constructs.
10. If data provider is goldrush, prefer decoded/metadata-aware reads before raw RPC output.
11. If private execution is true, include MagicBlock/Umbra private transfer hooks in runtime flow.

CRITICAL IMPLEMENTATION DETAILS:
- Load .env CORRECTLY using explicit path resolution:
  import {{ config }} from "dotenv";
  import {{ fileURLToPath }} from "url";
  import {{ dirname, join }} from "path";
  const __filename = fileURLToPath(import.meta.url);
  const botDir = dirname(dirname(__filename));
  config({{ path: join(botDir, ".env") }});
- REBALANCE_THRESHOLD_PCT must be parsed as a float, then converted to basis points (multiply by 100, then BigInt):
  const REBALANCE_THRESHOLD_PCT = BigInt(Math.round(parseFloat(process.env.REBALANCE_THRESHOLD_PCT || '1.5') * 100));
- When making HTTP requests (axios.get), include headers: {{ 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }}
- For API rate limiting, add try/catch around all fetch operations with proper logging.
- Log environment variables at startup for debugging.
- Ensure MCP_GATEWAY_URL defaults to http://127.0.0.1:8001 if not set.

OUTPUT FILES (generate exactly 3 files):
1. package.json — with "type": "module" and tsx dev dependencies (including axios, dotenv)
2. tsconfig.json — with rootDir: "src", include: ["src/**/*"], target: "ES2020", module: "ES2020"
3. src/index.ts — the main bot logic with proper dotenv loading and error handling
""".strip()


def main() -> None:
    args = parse_args()
    config = load_config(args)
    # Demo mode: use prebuilt prompt template and submit directly
    if getattr(args, "demo", False):
        import sys
        sys.path.insert(0, str(Path(__file__).parent))
        from demo.prompt_template import build_prompt, CONFIG
        prompt = build_prompt()
        config = CONFIG
        print(f"\nBot: {config['botName']} [DEMO MODE]")
        print(f"Chain: {config.get('chain', 'solana-mainnet')}")

        server_url = os.environ.get("META_AGENT_URL", "http://127.0.0.1:8000") + "/create-bot"
        try:
            response = requests.post(server_url, json={"prompt": prompt}, timeout=60)
            print("Status:", response.status_code)
            try:
                data = response.json()
                print(json.dumps(data, indent=2)[:4000])
            except Exception:
                print(response.text[:4000])
        except Exception as exc:
            print("Failed to call Meta-Agent:", exc)
        return

    prompt = build_prompt(config)

    print(f"\\nBot: {config['botName']}")
    print(f"Chain: {config['chain']}")

    server_url = os.environ.get("META_AGENT_URL", "http://127.0.0.1:8000") + "/create-bot"
    try:
        response = requests.post(server_url, json={"prompt": prompt}, timeout=60)
        print("Status:", response.status_code)
        try:
            data = response.json()
            print(json.dumps(data, indent=2)[:4000])
        except Exception:
            print(response.text[:4000])
    except Exception as exc:
        print("Failed to call Meta-Agent:", exc)


if __name__ == "__main__":
    main()
