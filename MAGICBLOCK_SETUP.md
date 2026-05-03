# MagicBlock Integration Setup Guide

This guide walks through configuring the MagicBlock TEE integration for Private Brain, Shielded Execution, and A2A Payments.

## Environment Variables

Add the following to your `.env.local` (or `.env`):

```env
# ──────────────────────────────────────────────────────────────────
# MagicBlock TEE Configuration
# ──────────────────────────────────────────────────────────────────

# Private Payments API endpoint
# This is where A2A payments, channels, and private balance queries are sent
MAGICBLOCK_PRIVATE_PAYMENTS_BASE_URL=https://per-payment-api.magicblock.app

# TEE Operator credentials (for signing auth challenges to validators)
# In production, these should come from a secure vault (AWS Secrets Manager, HashiCorp Vault, etc.)
# The operator pubkey is your account's public key on Solana
MAGICBLOCK_OPERATOR_PUBKEY=<your_operator_public_key_here>

# The operator signature is a signed challenge from the TEE validator
# This proves you own the operator keypair
MAGICBLOCK_OPERATOR_SIGNATURE=<signed_challenge_from_tee_validator>

# Session token TTL (milliseconds) — how long before tokens are refreshed
# Default: 3600000 (1 hour)
MAGICBLOCK_SESSION_TTL_MS=3600000

# ──────────────────────────────────────────────────────────────────
# Solana RPC Configuration
# ──────────────────────────────────────────────────────────────────

# The RPC endpoint used to confirm on-chain transactions (L1 Solana)
# Can be a public RPC or your own node
SOLANA_RPC_URL=https://api.mainnet-beta.solana.com

# For devnet testing:
# SOLANA_RPC_URL=https://api.devnet.solana.com

# For local testing:
# SOLANA_RPC_URL=http://127.0.0.1:8899

# ──────────────────────────────────────────────────────────────────
# Per-Agent API Keys (for Private Payments API authentication)
# ──────────────────────────────────────────────────────────────────

# Each agent that uses Private Payments needs an API key
# Format: AGENT_API_KEY_<AGENT_ID>
# Example for agent "agent-123":
AGENT_API_KEY_agent_123=ppa_abcdef0123456789...

# You can add more as needed:
# AGENT_API_KEY_agent_456=ppa_...
# AGENT_API_KEY_agent_789=ppa_...
```

## Getting Started

### 1. Register an Operator Account

To get the `MAGICBLOCK_OPERATOR_PUBKEY` and `MAGICBLOCK_OPERATOR_SIGNATURE`:

1. Create or use an existing Solana keypair
2. Register it as an operator with MagicBlock's TEE validators
3. Get the signed challenge and signature from the validator
4. Store these securely in your environment

**For devnet testing**, you can use a throwaway keypair:

```bash
solana-keygen new --outfile /tmp/mb_operator.json
```

Then extract the public key:

```bash
solana-keygen pubkey /tmp/mb_operator.json
```

### 2. Obtain Private Payments API Credentials

1. Contact MagicBlock to enable the Private Payments API for your account
2. They'll provide a base URL (or use the default: `https://per-payment-api.magicblock.app`)
3. Generate API keys for each agent (format: `ppa_<random_hex>`)

### 3. Generate Per-Agent API Keys

For each agent that will use A2A Payments:

```bash
# Generate a random key (example)
openssl rand -hex 24 | sed 's/^/ppa_/'
# Output: ppa_abc123def456...

# Store it in .env as:
# AGENT_API_KEY_<agent_id>=ppa_abc123def456...
```

### 4. Choose a Validator

Available validators:

- **Mainnet**: `mainnet-tee.magicblock.app`
- **Devnet**: `devnet-tee.magicblock.app`
- **Geofenced**:
  - `as.magicblock.app` (Asia)
  - `eu.magicblock.app` (Europe)
  - `us.magicblock.app` (US)
- **Devnet Geofenced**:
  - `devnet-as.magicblock.app`
  - `devnet-eu.magicblock.app`
  - `devnet-us.magicblock.app`
- **Local Testing**: `localhost:7799`

When enabling Private Brain or Shielded Execution for an agent, specify the validator:

```bash
curl -X POST http://localhost:3000/api/agents/<agentId>/private-brain/enable \
  -H "Content-Type: application/json" \
  -d '{
    "validator": "devnet-tee.magicblock.app",
    "memory_slots": 8,
    "geofence_regions": ["US", "EU"]
  }'
```

## Validator Endpoints Reference

| Validator | Endpoint | Pubkey | Region | Network |
|-----------|----------|--------|--------|---------|
| mainnet-tee.magicblock.app | https://mainnet-tee.magicblock.app | MTEWGuqxUpYZGFJQcp8tLN7x5v9BSeoFHYWQQ3n3xzo | Global | Mainnet |
| devnet-tee.magicblock.app | https://devnet-tee.magicblock.app | MTEWGuqxUpYZGFJQcp8tLN7x5v9BSeoFHYWQQ3n3xzo | Global | Devnet |
| as.magicblock.app | https://as.magicblock.app | MAS1Dt9qreoRMQ14YQuhg8UTZMMzDdKhmkZMECCzk57 | Asia | Mainnet |
| eu.magicblock.app | https://eu.magicblock.app | MEUGGrYPxKk17hCr7wpT6s8dtNokZj5U2L57vjYMS8e | Europe | Mainnet |
| us.magicblock.app | https://us.magicblock.app | MUS3hc9TCw4cGC12vHNoYcCGzJG1txjgQLZWVoeNHNd | US | Mainnet |
| devnet-as.magicblock.app | https://devnet-as.magicblock.app | MAS1Dt9qreoRMQ14YQuhg8UTZMMzDdKhmkZMECCzk57 | Asia | Devnet |
| devnet-eu.magicblock.app | https://devnet-eu.magicblock.app | MEUGGrYPxKk17hCr7wpT6s8dtNokZj5U2L57vjYMS8e | Europe | Devnet |
| devnet-us.magicblock.app | https://devnet-us.magicblock.app | MUS3hc9TCw4cGC12vHNoYcCGzJG1txjgQLZWVoeNHNd | US | Devnet |
| localhost:7799 | http://localhost:7799 | mAGicPQYBMvcYveUZA5F5UNNwyHvfYh5xkLS2Fr1mev | Local | Local |

## Vault Integration (Production)

For production deployments, store operator credentials in a secure vault instead of environment variables:

**AWS Secrets Manager:**

```typescript
import { SecretsManagerClient, GetSecretValueCommand } from "@aws-sdk/client-secrets-manager";

export async function getOperatorCredentialsFromVault() {
  const client = new SecretsManagerClient({ region: "us-east-1" });
  const response = await client.send(
    new GetSecretValueCommand({
      SecretId: "magicblock/operator-credentials",
    })
  );
  const secret = JSON.parse(response.SecretString || "{}");
  return {
    pubkey: secret.operatorPubkey,
    signature: secret.operatorSignature,
  };
}
```

**HashiCorp Vault:**

```typescript
import fetch from "node-fetch";

export async function getOperatorCredentialsFromVault() {
  const token = process.env.VAULT_TOKEN;
  const vaultUrl = process.env.VAULT_ADDR || "http://127.0.0.1:8200";

  const res = await fetch(`${vaultUrl}/v1/secret/data/magicblock/operator`, {
    headers: {
      "X-Vault-Token": token,
    },
  });

  const data = (await res.json()) as any;
  return {
    pubkey: data.data.data.operatorPubkey,
    signature: data.data.data.operatorSignature,
  };
}
```

Then update `magicblock-http.ts` to use your vault function:

```typescript
export async function getOperatorCredentials() {
  // Use vault in production
  if (process.env.NODE_ENV === "production") {
    return getOperatorCredentialsFromVault();
  }

  // Fall back to env vars for development
  const pubkey = String(process.env.MAGICBLOCK_OPERATOR_PUBKEY ?? "").trim();
  const signature = String(process.env.MAGICBLOCK_OPERATOR_SIGNATURE ?? "").trim();

  if (!pubkey || !signature) {
    throw new Error("Operator credentials not configured");
  }

  return { pubkey, signature };
}
```

## Troubleshooting

### "Unknown validator" error

Make sure the validator name matches exactly. Check [Validator Endpoints Reference](#validator-endpoints-reference) above.

### "TEE validator unreachable" (502)

The TEE validator is either:
- Offline or under maintenance
- Behind a firewall or geo-blocked
- Using a different endpoint URL

Try a different validator or check the MagicBlock status page.

### "MAGICBLOCK_PRIVATE_PAYMENTS_BASE_URL is not configured"

Add the URL to your `.env.local`:

```env
MAGICBLOCK_PRIVATE_PAYMENTS_BASE_URL=https://per-payment-api.magicblock.app
```

### "Private Payments login failed: 401"

The API key for the agent is incorrect or missing:

```env
AGENT_API_KEY_<agent_id>=ppa_...
```

Generate a new key and update your environment.

## Security Best Practices

1. **Never commit `.env` files** — Use `.env.local` (ignored by git)
2. **Rotate operator credentials regularly** — Update signatures and keys every 90 days
3. **Use vault for production** — Never store credentials in plain text env vars
4. **Limit API key scope** — If your payment API supports it, scope keys to specific agents or actions
5. **Monitor token expiry** — Tokens auto-refresh, but monitor cache hit rates in logs
6. **Enable OFAC checks** — Always keep `ofacCheckEnabled: true` for Private Brain

## Testing Configuration

```bash
# Test the Solana RPC connection
curl -X POST $SOLANA_RPC_URL \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"getSlot"}'

# Test TEE validator health
curl https://<validator_endpoint>/health

# Test Private Payments API
curl https://per-payment-api.magicblock.app/health
```

## Next Steps

After configuration:

1. Read [MAGICBLOCK_INTEGRATION_TEST.md](./MAGICBLOCK_INTEGRATION_TEST.md) for testing flows
2. Check the service class implementations in:
   - `frontend/lib/private-brain.ts`
   - `frontend/lib/shielded-execution.ts`
   - `frontend/lib/a2a-payment.ts`
3. Review the API route implementations in `frontend/app/api/agents/[agentId]/`
