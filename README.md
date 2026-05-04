# synth

## Architecture & Security

Synth runs agents in a backend-only execution model with per-agent Docker isolation.

- Agent execution isolation: each generated bot runs inside its own container, not in the browser and not as a raw host-level child process.
- Read-only container root filesystem: worker runtime uses Docker `ReadonlyRootfs` to reduce write-surface and limit destructive behavior from malformed or hallucinated code paths.
- Least-privilege runtime defaults: containers run with dropped Linux capabilities and `no-new-privileges` enabled, plus memory/CPU/PID limits.
- Backend telemetry path: dashboard log streaming is sourced from worker terminal-log APIs (`/api/agents/[agentId]/terminal-logs`) for auditable operational visibility.
- RPC Fast simulation sandbox: Solana simulation and runtime requests are routed through the configured RPC Fast Frankfurt endpoint to keep test loops low-latency and reduce stale quote risk.
- Mainnet safety posture: production mainnet rollout is gated behind external security review; we are actively targeting the Adevar Labs audit track before enabling unrestricted live deployment.

## Meta-Agent Limits

- `MAX_INPUT_TOKENS` (default 8000) caps LLM input size in the meta-agent to avoid request size errors.
- `INPUT_TOKEN_SHRINK_RATIO` (default 0.75) controls how aggressively the meta-agent shrinks input on a 413/token-limit retry.

## Worker GoldRush Environment

The worker's GoldRush stream manager uses worker-level credentials and endpoints (separate from per-agent encrypted env).

- `GOLDRUSH_API_KEY`: API key used by worker stream subscriptions.
- `GOLDRUSH_STREAM_URL`: SSE/WebSocket-compatible stream endpoint used by worker and frontend proxies.
- `GOLDRUSH_MCP_URL`: GoldRush MCP endpoint allowlisted for agent runtime calls.
- `GOLDRUSH_STREAM_EVENTS` (optional): default comma-separated filters, for example `lp_pull,drainer_approval,phishing_airdrop`.

## Dodo Integration

To enable Dodo payment and metering features for generated bots:

- Configure the Dodo MCP server URL in `agents/.env` or environment: `DODO_DOCS_MCP_URL` (default: `http://127.0.0.1:5002`).
- Set `DODO_PLAN_PRO_ID` and `DODO_API_KEY` in `agents/.env` when using metered execution flows.
- Set `DODO_WEBHOOK_SECRET` and implement webhook HMAC verification in production; a sample Dodo MCP server is available at `agents/dodo-mcp-server/` for local development.

The Meta-Agent will only fetch Dodo docs/context when the user's prompt mentions payments, splitting, meter, or checkout flows. Generator rules forbid use of local CLIs; use Jupiter V6 HTTP API (quote-api.jup.ag) and send signed transactions via MCP `send_raw_transaction`.
