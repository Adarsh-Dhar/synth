const SOLANA_ALLOWED_MCPS = new Set(["solana"]);
const SOLANA_NETWORKS = new Set(["devnet", "testnet", "mainnet"]);

function defaultSolanaNetwork(): string {
  const envNetwork = normalizeMcp(process.env.DEFAULT_SOLANA_NETWORK ?? process.env.SOLANA_NETWORK);
  return envNetwork && SOLANA_NETWORKS.has(envNetwork) ? envNetwork : "devnet";
}

function normalizeMcp(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  return normalized.length > 0 ? normalized : null;
}

function asMcpList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const item of value) {
    const normalized = normalizeMcp(item);
    if (!normalized) continue;
    if (!out.includes(normalized)) out.push(normalized);
  }
  return out;
}
export function sanitizeIntentMcpLists(intent: Record<string, unknown>): Record<string, unknown> {
  const requestedNetwork = normalizeMcp(intent.network);
  const required = asMcpList(intent.required_mcps);
  const mcps = asMcpList(intent.mcps);

  // Only Solana is supported
  const network = requestedNetwork && SOLANA_NETWORKS.has(requestedNetwork) ? requestedNetwork : defaultSolanaNetwork();
  const nextRequired = ["solana"];
  let nextMcps = [...required, ...mcps].filter((name) => SOLANA_ALLOWED_MCPS.has(name));
  if (!nextMcps.includes("solana")) nextMcps.unshift("solana");
  nextMcps = Array.from(new Set(nextMcps));
  return {
    ...intent,
    chain: "solana",
    network,
    required_mcps: nextRequired,
    mcps: nextMcps,
  };
}

export function shouldUseLegacyDeterministicFallback(): boolean {
  // Legacy deterministic fallback removed — always opt out.
  return false;
}