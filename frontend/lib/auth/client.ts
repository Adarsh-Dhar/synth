import bs58 from "bs58";

const AUTH_CACHE_KEY = "synth.wallet.auth.v1";
const AUTH_TTL_MS = 4 * 60 * 1000;

type CacheRecord = {
  wallet: string;
  timestamp: number;
  signature: string;
};

export type WalletSigner = {
  publicKey: { toBase58(): string } | null;
  signMessage?: (message: Uint8Array) => Promise<Uint8Array>;
};

function loadCached(wallet: string): CacheRecord | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.sessionStorage.getItem(AUTH_CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as CacheRecord;
    if (!parsed || parsed.wallet !== wallet) return null;
    if (!parsed.signature || !parsed.timestamp) return null;
    if (Date.now() - parsed.timestamp > AUTH_TTL_MS) return null;
    return parsed;
  } catch {
    return null;
  }
}

function saveCached(record: CacheRecord): void {
  if (typeof window === "undefined") return;
  try {
    window.sessionStorage.setItem(AUTH_CACHE_KEY, JSON.stringify(record));
  } catch {
    // Ignore write failures.
  }
}

export async function getWalletAuthHeaders(wallet: WalletSigner): Promise<Record<string, string>> {
  const walletAddress = wallet.publicKey?.toBase58() ?? "";
  if (!walletAddress) {
    throw new Error("Wallet is not connected.");
  }

  const cached = loadCached(walletAddress);
  if (cached) {
    return {
      "x-synth-wallet": cached.wallet,
      "x-synth-timestamp": String(cached.timestamp),
      "x-synth-signature": cached.signature,
    };
  }

  if (!wallet.signMessage) {
    throw new Error("Wallet does not support message signing.");
  }

  const timestamp = Date.now();
  const message = `synth-auth:v1:${walletAddress}:${timestamp}`;
  const signatureBytes = await wallet.signMessage(new TextEncoder().encode(message));
  const signature = bs58.encode(signatureBytes);

  const record: CacheRecord = {
    wallet: walletAddress,
    timestamp,
    signature,
  };
  saveCached(record);

  return {
    "x-synth-wallet": walletAddress,
    "x-synth-timestamp": String(timestamp),
    "x-synth-signature": signature,
  };
}
