# synth

## Architecture & Security

Synth runs agents in a backend-only execution model with per-agent Docker isolation.

- Agent execution isolation: each generated bot runs inside its own container, not in the browser and not as a raw host-level child process.
- Read-only container root filesystem: worker runtime uses Docker `ReadonlyRootfs` to reduce write-surface and limit destructive behavior from malformed or hallucinated code paths.
- Least-privilege runtime defaults: containers run with dropped Linux capabilities and `no-new-privileges` enabled, plus memory/CPU/PID limits.
- Backend telemetry path: dashboard log streaming is sourced from worker terminal-log APIs (`/api/agents/[agentId]/terminal-logs`) for auditable operational visibility.
- RPC Fast simulation sandbox: Solana simulation and runtime requests are routed through the configured RPC Fast Frankfurt endpoint to keep test loops low-latency and reduce stale quote risk.
- Mainnet safety posture: production mainnet rollout is gated behind external security review; we are actively targeting the Adevar Labs audit track before enabling unrestricted live deployment.
