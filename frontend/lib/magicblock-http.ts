/**
 * MagicBlock HTTP Client Utilities
 *
 * Handles authenticated requests to the Private Payments API and TEE validators,
 * with session token caching and automatic token refresh.
 */

// Session token cache: validator endpoint → { token, expiresAt }
const sessionTokenCache = new Map<string, { token: string; expiresAt: number }>();

// Agent-specific session token cache: agentId → { token, expiresAt }
const agentSessionTokenCache = new Map<string, { token: string; expiresAt: number }>();

/**
 * Get the Private Payments API base URL from environment
 */
export function getPrivatePaymentsBase(): string {
  const base = String(process.env.MAGICBLOCK_PRIVATE_PAYMENTS_BASE_URL ?? "").trim();
  if (!base) {
    throw new Error(
      "MAGICBLOCK_PRIVATE_PAYMENTS_BASE_URL is not configured. Set it in your .env file."
    );
  }
  return base.replace(/\/+$/, "");
}

/**
 * Get operator credentials from environment
 * In production, these should come from a secure vault
 */
export function getOperatorCredentials() {
  const pubkey = String(process.env.MAGICBLOCK_OPERATOR_PUBKEY ?? "").trim();
  const signature = String(process.env.MAGICBLOCK_OPERATOR_SIGNATURE ?? "").trim();

  if (!pubkey || !signature) {
    throw new Error(
      "MAGICBLOCK_OPERATOR_PUBKEY and MAGICBLOCK_OPERATOR_SIGNATURE must be set in .env"
    );
  }

  return { pubkey, signature };
}

/**
 * Get a validator authentication token
 * Cached and refreshed 30s before expiry
 */
export async function getValidatorAuthToken(validatorEndpoint: string): Promise<string> {
  const cached = sessionTokenCache.get(validatorEndpoint);
  if (cached && cached.expiresAt > Date.now() + 30_000) {
    return cached.token;
  }

  const credentials = getOperatorCredentials();

  const res = await fetch(`${validatorEndpoint}/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      operator: credentials.pubkey,
      signature: credentials.signature,
    }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(
      `Failed to authenticate with TEE validator at ${validatorEndpoint}: ${res.status} ${body.slice(0, 200)}`
    );
  }

  const data = (await res.json()) as { token: string; expiresIn?: number };
  const expiresAt = Date.now() + (data.expiresIn ?? 3600) * 1000;
  sessionTokenCache.set(validatorEndpoint, { token: data.token, expiresAt });
  return data.token;
}

/**
 * Get an agent-specific session token for the Private Payments API
 * Cached and refreshed 30s before expiry
 */
export async function getAgentSessionToken(agentId: string): Promise<string> {
  const cached = agentSessionTokenCache.get(agentId);
  if (cached && cached.expiresAt > Date.now() + 30_000) {
    return cached.token;
  }

  const base = getPrivatePaymentsBase();
  const { prisma } = await import("@/lib/prisma");

  const wallet = await prisma.botWallet.findUnique({
    where: { agentId },
    select: { pubkey: true },
  });

  if (!wallet?.pubkey) {
    throw new Error(`No wallet configured for agent ${agentId}`);
  }

  // Retrieve the agent's API key from environment or secure vault
  // For now, we expect it to be in env vars as AGENT_API_KEY_<agentId>
  // In production, fetch from KMS/Vault
  const apiKey = process.env[`AGENT_API_KEY_${agentId}`] ?? "";
  if (!apiKey) {
    throw new Error(
      `API key not found for agent ${agentId}. Set AGENT_API_KEY_${agentId} in .env`
    );
  }

  const res = await fetch(`${base}/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      pubkey: wallet.pubkey,
      apiKey,
    }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Private Payments login failed for agent ${agentId}: ${res.status} ${body.slice(0, 200)}`);
  }

  const data = (await res.json()) as { token: string; expiresIn?: number };
  const expiresAt = Date.now() + (data.expiresIn ?? 3600) * 1000;
  agentSessionTokenCache.set(agentId, { token: data.token, expiresAt });
  return data.token;
}

/**
 * Make an authenticated request to the Private Payments API
 */
export async function privatePaymentsRequest<T>(
  agentId: string,
  method: "GET" | "POST" | "PUT" | "DELETE",
  path: string,
  body?: Record<string, unknown>
): Promise<T> {
  const base = getPrivatePaymentsBase();
  const token = await getAgentSessionToken(agentId);

  const res = await fetch(`${base}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });

  if (!res.ok) {
    const errBody = await res.text().catch(() => "");
    throw new Error(
      `Private Payments API ${method} ${path} failed: ${res.status} ${errBody.slice(0, 300)}`
    );
  }

  return (await res.json()) as T;
}

/**
 * Clear all cached tokens (useful for testing or when rotating keys)
 */
export function clearTokenCache(): void {
  sessionTokenCache.clear();
  agentSessionTokenCache.clear();
}
