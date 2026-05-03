# MagicBlock Integration Test Plan

## Prerequisites

- Set `DATABASE_URL` for the frontend Prisma client.
- Set `MAGICBLOCK_OPERATOR_PUBKEY` and `MAGICBLOCK_OPERATOR_SIGNATURE`.
- Set `MAGICBLOCK_PRIVATE_PAYMENTS_BASE_URL` if you want the A2A payment routes to hit the real Private Payments API.
- Set `SOLANA_RPC_URL` to a reachable cluster RPC.

## Unit Tests

Run the service-layer tests with:

```bash
cd frontend
pnpm test:unit
```

These cover:

- Private Brain enable, delegate, disable, and TEE state reads.
- Shielded Execution enable, shielded submission, and settlement accounting.
- A2A wallet, channel, and payment flows.

## Manual Smoke Tests

1. Enable Private Brain for an enterprise-owned agent.
2. Delegate the state account using a client-signed transaction.
3. Confirm the agent can read state through the TEE-backed `read-state` route.
4. Enable Shielded Execution and submit a shielded instruction.
5. Open an A2A payment channel, activate it with a confirmed L1 tx signature, then send a payment.
6. Trigger the worker and confirm scheduled undelegation and settlement polling run without errors.

## Worker Verification

The worker now starts `magicblock-tasks.ts` on boot and polls for:

- `PrivateBrainAudit` rows with `action = "undelegate_scheduled"`.
- `ShieldedExecutionConfig` rows whose settlement interval has elapsed.

If you want the worker to submit real raw transactions, attach base64 payloads via audit metadata or the corresponding `MAGICBLOCK_UNDELEGATE_TX_BASE64` / `MAGICBLOCK_SETTLEMENT_TX_BASE64` environment variables.

## Expected Results

- The worker should keep configs and audits in sync without creating orphaned state.
- Settlement counters should advance only when a settlement job is processed.
- Undelegation jobs should clear the config back to inactive after the raw tx succeeds.