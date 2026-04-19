# DX Report: Enterprise DeFAI Migration

## Scope
This report tracks the migration from browser-simulated execution to backend-verified DeFAI runtime.

## Date
19 April 2026

## Current Status Snapshot (19 April 2026)

### Completed Since Phase 1
- Prisma client outputs are present for both app surfaces:
	- `frontend/lib/generated/prisma/*`
	- `worker/src/lib/generated/prisma/*`
- Worker compile verification is passing (`pnpm -C worker exec tsc -p tsconfig.json --noEmit`).
- Dodo webhook security + success-path coverage exists in route tests:
	- unauthorized webhook rejected
	- bad signature rejected
	- `payment.succeeded` upsert path validated
- Subscription enforcement is active in runtime/auth paths (frontend guard + worker start guard).

### Partial / Still Open
- Cross-surface compile verification is not fully complete:
	- frontend TypeScript check currently fails at `frontend/lib/auth/server.ts` with a `select/include` union typing error (TS2345).
- Docker runtime metadata is collected in memory (`containerId`, resource limits), but not yet persisted for audit/debug views.
- RPC Fast simulation routing is documented, but benchmark logs/artifacts are not yet captured in this report.
- Dodo replay/idempotency hardening is partially covered (upsert exists), but stricter replay-focused tests are still missing.

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

## Jupiter CLI Agent Friction Log

### Run 1
- Date: 19 April 2026
- Trace id: jupiter-cli-smoke-1
- Prompt: "Build a Solana bot that swaps SOL to USDC every 30s when in simulation mode and uses Jupiter for swaps."
- Entry point used: `MetaAgent.build_bot(...)` from `agents/orchestrator.py`.

Observed generator behavior:
- The model correctly imported `execSync` from `child_process` and wrapped command execution behind `SIMULATION_MODE`.
- The model generated this command shape: `jupiter-cli swap --input-mint SOL --output-mint ${TOKEN_MINT_ADDRESS} --amount ${TRADE_AMOUNT_LAMPORTS} --slippage-bps 50`.

Friction / corrections needed:
- Amount formatting issue: model used `TRADE_AMOUNT_LAMPORTS` (smallest units) while prompt guidance requires Jupiter CLI standard units.
- Mint formatting issue: model used `SOL` as input mint token alias instead of a canonical mint address variable.
- Unit-coupling issue: profit threshold remained tied to lamport-style naming (`MIN_PROFIT_LAMPORTS`) even though swap output was USDC units.
- No obvious flag hallucinations in this run; command used expected `swap`, `--input-mint`, `--output-mint`, `--amount`, `--slippage-bps` pattern.

Action taken:
- Keep this run as baseline evidence for bounty DX scoring.
- Next prompt iteration should enforce two additional constraints:
	1) `--amount` must be derived from token decimal-normalized standard units.
	2) `--input-mint` and `--output-mint` must come from env mint addresses, never symbolic aliases.

### Run 2
- Date: 19 April 2026
- Trace id: jupiter-cli-smoke-2
- Prompt: "Build a Solana bot that swaps SOL to USDC every 30s when in simulation mode and uses Jupiter for swaps. Use mint addresses from env vars only and standard-unit CLI amounts."

Observed generator behavior:
- The model retained `execSync` usage and simulation gating correctly.
- The generated command moved input mint to env style: `--input-mint ${process.env.SOL_MINT_ADDRESS}` and `--output-mint ${TOKEN_MINT_ADDRESS}`.
- The model introduced a decimal standard-unit conversion before `--amount`: `Number(TRADE_AMOUNT_LAMPORTS) / 1_000_000_000`.

Remaining friction:
- Conversion still used `Number(...)` which can lose precision on large values; should stay BigInt-safe with explicit decimal string conversion logic.
- Variable naming drift remains (`TRADE_AMOUNT_LAMPORTS`) even in standard-unit path, which risks operator confusion.
- The model still hard-fails when required env vars are missing (`throw new Error`), which is stricter than earlier resilience guidance.

Action taken:
- Prompt hardened further to require env-address mints and decimal-normalized amount semantics.
- Keep Run 2 as comparison evidence showing reduced mint-symbol hallucination and partial amount-format improvement.

## Next Steps
- Fix frontend TypeScript error in `frontend/lib/auth/server.ts` and re-run compile verification for both frontend and worker.
- Persist Docker runtime metadata (`containerId`, image, memory/cpu/pids profile, start/stop timestamps) to DB-backed audit records.
- Add benchmark capture for RPC Fast simulation routing (before/after latency + quote staleness metrics) and attach run logs.
- Add explicit Dodo replay/idempotency tests:
	1) duplicate `payment.succeeded` with same `externalReference`
	2) out-of-order `payment.failed` after success
	3) signature-valid retried delivery behavior
