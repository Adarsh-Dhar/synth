#!/usr/bin/env python3
"""
agents/demo/run_demo.py

End-to-end demo runner:
  1. Calls Meta-Agent /create-bot with the injected prompt
  2. Writes generated files into worker/agents/generated/
  3. Calls worker /demo/run to execute the bot in the sandbox
  4. Streams logs until SIGINT

Usage:
  python agents/demo/run_demo.py [--dry-run] [--worker-url http://...]
"""

import argparse
import json
import os
import sys
import time
from pathlib import Path

import requests

sys.path.insert(0, str(Path(__file__).parent.parent))
from demo.prompt_template import build_prompt, CONFIG

ROOT = Path(__file__).parent.parent.parent
WORKER_GENERATED_DIR = ROOT / "worker" / "agents" / "generated"


def parse_args():
    p = argparse.ArgumentParser()
    p.add_argument("--dry-run", action="store_true",
                   help="Generate code only, don't run in worker")
    p.add_argument("--meta-agent-url", default=CONFIG["metaAgentUrl"])
    p.add_argument("--worker-url", default="http://127.0.0.1:3001")
    p.add_argument("--simulation", action="store_true", default=True)
    p.add_argument("--no-simulation", dest="simulation", action="store_false")
    return p.parse_args()


def generate_bot(meta_agent_url: str, prompt: str) -> dict:
    print("[demo] Calling Meta-Agent to generate bot code...")
    resp = requests.post(
        f"{meta_agent_url}/create-bot",
        json={"prompt": prompt},
        timeout=240,
    )
    resp.raise_for_status()
    data = resp.json()
    if data.get("status") not in ("ready", "complete"):
        raise RuntimeError(f"Bot generation failed: {data}")
    return data


def write_files(data: dict) -> Path:
    files = data.get("output", {}).get("files") or data.get("files") or []
    if not files:
        raise RuntimeError("No files returned from Meta-Agent")

    bot_dir = WORKER_GENERATED_DIR / f"bot_{int(time.time())}"
    bot_dir.mkdir(parents=True, exist_ok=True)

    for f in files:
        fp = bot_dir / f["filepath"]
        fp.parent.mkdir(parents=True, exist_ok=True)
        content = f["content"]
        # Handle both string and dict content (API returns dict for JSON files)
        if isinstance(content, dict):
            content = json.dumps(content, indent=2)
        elif not isinstance(content, str):
            content = str(content)
        fp.write_text(content, encoding="utf-8")
        print(f"[demo] wrote {fp.relative_to(ROOT)}")

    # Write demo .env alongside the bot
    env_path = bot_dir / ".env"
    env_content = "\n".join([
        f"SOLANA_NETWORK={CONFIG['network']}",
        f"MCP_GATEWAY_URL={CONFIG['mcpGatewayUrl']}",
        f"SIMULATION_MODE={'true' if CONFIG.get('simulationMode', True) else 'false'}",
        f"POLL_INTERVAL_MS={CONFIG['pollIntervalMs']}",
        f"REBALANCE_THRESHOLD_PCT={CONFIG['thresholdPct']}",
        "USER_WALLET_ADDRESS=",
        "SOLANA_KEY=",
        f"KAMINO_APY_URL=https://api.kamino.finance/v1/kamino-market/USDC/reserves",
        f"SUSDE_APY_URL=https://api.ethena.fi/apy",
        "",
    ])
    env_path.write_text(env_content)
    print(f"[demo] wrote .env to {env_path.relative_to(ROOT)}")

    return bot_dir


def run_in_worker(worker_url: str, bot_dir: Path, simulation: bool):
    print(f"[demo] Submitting bot to worker at {worker_url}...")

    # Read all files to send to worker
    files_payload = []
    for fp in bot_dir.rglob("*"):
        if fp.is_file():
            files_payload.append({
                "filepath": str(fp.relative_to(bot_dir)),
                "content": fp.read_text(encoding="utf-8", errors="replace"),
            })

    payload = {
        "botName": CONFIG["botName"],
        "files": files_payload,
        "env": {
            "SOLANA_NETWORK": CONFIG["network"],
            "MCP_GATEWAY_URL": CONFIG["mcpGatewayUrl"],
            "SIMULATION_MODE": "true" if simulation else "false",
            "POLL_INTERVAL_MS": str(CONFIG["pollIntervalMs"]),
            "REBALANCE_THRESHOLD_PCT": str(CONFIG["thresholdPct"]),
        },
    }

    resp = requests.post(
        f"{worker_url}/demo/run",
        json=payload,
        timeout=30,
    )
    resp.raise_for_status()
    run_data = resp.json()
    agent_id = run_data.get("agentId") or run_data.get("id")
    print(f"[demo] Bot running — agentId={agent_id}")
    return agent_id


def stream_logs(worker_url: str, agent_id: str):
    print(f"[demo] Streaming logs for agent {agent_id} (Ctrl+C to stop)...")
    try:
        with requests.get(
            f"{worker_url}/demo/logs/{agent_id}",
            stream=True,
            timeout=3600,
        ) as resp:
            for line in resp.iter_lines():
                if line:
                    print(f"  {line.decode('utf-8', errors='replace')}")
    except KeyboardInterrupt:
        print("\n[demo] Interrupted. Stopping bot...")
        requests.post(f"{worker_url}/demo/stop/{agent_id}", timeout=10)


def main():
    args = parse_args()
    prompt = build_prompt()

    print(f"[demo] Strategy: {CONFIG['strategy']}")
    print(f"[demo] Bot: {CONFIG['botName']}")
    print(f"[demo] Simulation: {args.simulation}")
    print()

    data = generate_bot(args.meta_agent_url, prompt)
    bot_dir = write_files(data)

    if args.dry_run:
        print(f"\n[demo] --dry-run: files written to {bot_dir}. Exiting.")
        return

    agent_id = run_in_worker(args.worker_url, bot_dir, args.simulation)
    stream_logs(args.worker_url, agent_id)


if __name__ == "__main__":
    main()
#!/usr/bin/env python3
