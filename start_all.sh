#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FRONTEND_DIR="$ROOT_DIR/frontend"
AGENTS_DIR="$ROOT_DIR/agents"
WORKER_DIR="$ROOT_DIR/worker"

declare -a PIDS=()
declare -a NAMES=()

cleanup() {
	local pid
	for pid in "${PIDS[@]:-}"; do
		if kill -0 "$pid" 2>/dev/null; then
			kill "$pid" 2>/dev/null || true
		fi
	done

	for pid in "${PIDS[@]:-}"; do
		wait "$pid" 2>/dev/null || true
	done
}

trap cleanup EXIT INT TERM

start_service() {
	local name="$1"
	local dir="$2"
	local cmd="$3"

	(
		cd "$dir"
		eval "$cmd"
	) &

	PIDS+=("$!")
	NAMES+=("$name")
	echo "[$name] started (pid=$!)"
}

if [[ ! -d "$FRONTEND_DIR" || ! -d "$AGENTS_DIR" || ! -d "$WORKER_DIR" ]]; then
	echo "Expected frontend, agents, and worker directories under $ROOT_DIR"
	exit 1
fi

kill_port_processes() {
	local port="$1"
	local pids
	pids="$(lsof -tiTCP:"$port" -sTCP:LISTEN 2>/dev/null || true)"
	if [[ -z "$pids" ]]; then
		return
	fi

	echo "Port $port is in use by PID(s): $pids. Stopping them..."
	kill $pids 2>/dev/null || true
	sleep 1

	pids="$(lsof -tiTCP:"$port" -sTCP:LISTEN 2>/dev/null || true)"
	if [[ -n "$pids" ]]; then
		echo "Force stopping PID(s) on port $port: $pids"
		kill -9 $pids 2>/dev/null || true
	fi
}

kill_port_processes 5000
kill_port_processes 5001
kill_port_processes 5002
kill_port_processes 8001
kill_port_processes 8011
kill_port_processes 8012
kill_port_processes 8013
kill_port_processes 8014

ensure_node_deps() {
	local dir="$1"
	if [[ -x "$dir/node_modules/.bin/tsx" ]]; then
		return
	fi

	echo "[$(basename "$dir")] installing Node dependencies..."
	if [[ -f "$dir/package-lock.json" ]]; then
		(
			cd "$dir"
			npm install --no-fund --no-audit
		)
	else
		(
			cd "$dir"
			pnpm install
		)
	fi
}

if [[ -x "$AGENTS_DIR/.venv/bin/python" ]]; then
	AGENTS_PYTHON="$AGENTS_DIR/.venv/bin/python"
else
	AGENTS_PYTHON="python3"
fi

ensure_node_deps "$AGENTS_DIR/solana-mcp-server"
ensure_node_deps "$AGENTS_DIR/goldrush-mcp-server"
ensure_node_deps "$AGENTS_DIR/magicblock-mcp-server"
ensure_node_deps "$AGENTS_DIR/jupiter-mcp-server"
ensure_node_deps "$AGENTS_DIR/dodo-mcp-server"

start_service \
	"mcp-solana" \
	"$AGENTS_DIR/solana-mcp-server" \
	"PORT=8001 HOST=127.0.0.1 pnpm dev"

start_service \
	"mcp-goldrush" \
	"$AGENTS_DIR/goldrush-mcp-server" \
	"PORT=8011 HOST=127.0.0.1 pnpm dev"

start_service \
	"mcp-magicblock" \
	"$AGENTS_DIR/magicblock-mcp-server" \
	"PORT=8012 HOST=127.0.0.1 pnpm dev"

start_service \
	"mcp-jupiter" \
	"$AGENTS_DIR/jupiter-mcp-server" \
	"PORT=8013 HOST=127.0.0.1 pnpm dev"

start_service \
	"mcp-dodo" \
	"$AGENTS_DIR/dodo-mcp-server" \
	"PORT=8014 HOST=127.0.0.1 pnpm dev"

start_service \
	"frontend" \
	"$FRONTEND_DIR" \
	"PORT=5000 META_AGENT_URL=http://127.0.0.1:5001 NEXT_PUBLIC_META_AGENT_URL=http://127.0.0.1:5001 WORKER_URL=http://127.0.0.1:5002 MCP_GATEWAY_URL=http://127.0.0.1:8001 NEXT_PUBLIC_MCP_GATEWAY_URL=http://127.0.0.1:8001 pnpm dev --port 5000"

start_service \
	"agents" \
	"$AGENTS_DIR" \
	"SOLANA_MCP_URL=http://127.0.0.1:8001 DODO_MCP_URL=http://127.0.0.1:8014 JUPITER_DOCS_MCP_URL=http://127.0.0.1:8013 DODO_DOCS_MCP_URL=http://127.0.0.1:8014 JUPITER_MCP_SSE_URL=http://127.0.0.1:8013/sse DODO_MCP_SSE_URL=http://127.0.0.1:8014/sse SOLANA_MCP_SSE_URL= GOLDRUSH_MCP_SSE_URL= UMBRA_MCP_SSE_URL= \"$AGENTS_PYTHON\" -m uvicorn main:app --reload --host 0.0.0.0 --port 5001"

start_service \
	"worker" \
	"$WORKER_DIR" \
	"pnpm exec tsc -p tsconfig.json && PORT=5002 node dist/index.js"

echo "All services started."
echo "frontend: http://localhost:5000"
echo "agents:   http://localhost:5001"
echo "worker:   http://localhost:5002"
echo "mcp-solana:     http://127.0.0.1:8001"
echo "mcp-goldrush:   http://127.0.0.1:8011"
echo "mcp-magicblock: http://127.0.0.1:8012"
echo "mcp-jupiter:    http://127.0.0.1:8013/sse"
echo "mcp-dodo:       http://127.0.0.1:8014/sse"

while true; do
	i=0
	for pid in "${PIDS[@]}"; do
		if ! kill -0 "$pid" 2>/dev/null; then
			wait "$pid"
			exit_code=$?
			echo "${NAMES[$i]} exited with status $exit_code"
			exit "$exit_code"
		fi
		i=$((i + 1))
	done
	sleep 1
done
