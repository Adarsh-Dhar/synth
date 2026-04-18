# DX Report: Enterprise DeFAI Migration

## Scope
This report tracks the migration from browser-simulated execution to backend-verified DeFAI runtime.

## Date
19 April 2026

## Decisions Locked
- Remove TradeLog EVM legacy field `profitEth` and keep `profitUsd` for GoldRush-compatible USD reporting.
- Add agent privacy/session fields: `umbraViewingKey`, `umbraSpendingKey`, `magicBlockSessionId`.
- Use hard cutover from WebContainer browser execution to backend worker runtime.
- Integrate Jupiter Docs MCP retrieval in prompt generation before execution-path Jupiter upgrades.

## Implemented (Phase 1)
- Prisma schema expanded with Agent privacy/session fields and new `Subscription` model.
- Migration SQL added for schema transition.
- API routes updated to persist trade logs without `profitEth`.
- Frontend package cleanup completed: `@jup-ag/api`, `@webcontainer/api`, `@xterm/xterm`, and `@xterm/addon-fit` are absent from dependencies.
- Worker package updated with Docker SDK dependencies (`dockerode`, `tar`, `stream-to-promise`).
- Python MCP gateway no longer serves hardcoded fake tool data; now forwards to real upstream MCP endpoints.
- Orchestrator now attempts live Jupiter Docs MCP context retrieval and injects it into generator prompts.
- Dodo payments webhook route added to upsert `Subscription` and trigger x402 delivery path.
- Worker runtime execution hardened: agents now run inside isolated Docker containers (no host-level `spawn` execution of bot code).

## Next Steps
- Regenerate Prisma clients and verify compile across frontend and worker.
- Finish frontend hard-cutover UX cleanup where legacy WebContainer copy/routes remain.
- Persist Docker runtime metadata (container id/image/resource profile) for audit/debug views.
- Add RPC Fast simulation routing and benchmark logs.
- Add webhook signature/idempotency tests for Dodo payloads.
