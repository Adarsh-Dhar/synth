"use client";

/**
 * frontend/lib/auth/privy-client.ts
 *
 * Unified auth-header helper that works for BOTH:
 *  - Solana wallet users  → HMAC signed message (existing flow)
 *  - Privy OAuth users    → Privy access token (JWT)
 *
 * Usage (replaces getWalletAuthHeaders in most places):
 *
 *   import { useAuthHeaders } from "@/lib/auth/privy-client";
 *   const getHeaders = useAuthHeaders();
 *   const headers = await getHeaders();
 *   fetch("/api/agents", { headers });
 */

import { usePrivy } from "@privy-io/react-auth";
import { useWallets } from "@privy-io/react-auth/solana";
import { useCallback } from "react";
import bs58 from "bs58";

export type AuthHeaders = Record<string, string>;

const WALLET_AUTH_CACHE_KEY = "synth.wallet.auth.v1";
const AUTH_TTL_MS = 4 * 60 * 1000; // 4 minutes

// ─── Wallet signature cache (unchanged from existing client.ts) ───────────────

type WalletCacheRecord = {
  wallet: string;
  timestamp: number;
  signature: string;
};

function loadWalletCache(wallet: string): WalletCacheRecord | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.sessionStorage.getItem(WALLET_AUTH_CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as WalletCacheRecord;
    if (!parsed || parsed.wallet !== wallet) return null;
    if (!parsed.signature || !parsed.timestamp) return null;
    if (Date.now() - parsed.timestamp > AUTH_TTL_MS) return null;
    return parsed;
  } catch {
    return null;
  }
}

function saveWalletCache(record: WalletCacheRecord): void {
  if (typeof window === "undefined") return;
  try {
    window.sessionStorage.setItem(WALLET_AUTH_CACHE_KEY, JSON.stringify(record));
  } catch {}
}

// ─── Build Privy JWT headers ──────────────────────────────────────────────────

function buildPrivyHeaders(accessToken: string, userId: string): AuthHeaders {
  return {
    "x-synth-privy-token": accessToken,
    "x-synth-privy-user": userId,
  };
}

// ─── Build wallet signature headers (existing flow) ───────────────────────────

async function buildWalletHeaders(
  walletAddress: string,
  signMessage: (msg: Uint8Array) => Promise<Uint8Array>
): Promise<AuthHeaders> {
  const cached = loadWalletCache(walletAddress);
  if (cached) {
    return {
      "x-synth-wallet": cached.wallet,
      "x-synth-timestamp": String(cached.timestamp),
      "x-synth-signature": cached.signature,
    };
  }

  const timestamp = Date.now();
  const message = `synth-auth:v1:${walletAddress}:${timestamp}`;
  const signatureBytes = await signMessage(new TextEncoder().encode(message));
  const signature = bs58.encode(signatureBytes);

  saveWalletCache({ wallet: walletAddress, timestamp, signature });

  return {
    "x-synth-wallet": walletAddress,
    "x-synth-timestamp": String(timestamp),
    "x-synth-signature": signature,
  };
}

// ─── Hook: useAuthHeaders ─────────────────────────────────────────────────────

/**
 * Returns a stable async function that builds the correct auth headers
 * depending on how the user authenticated:
 *
 *   • Wallet user   → x-synth-wallet / timestamp / signature
 *   • OAuth user    → x-synth-privy-token / x-synth-privy-user
 */
export function useAuthHeaders() {
  const { user, getAccessToken, authenticated } = usePrivy();
  const { wallets } = useWallets(); 

  return useCallback(async (): Promise<AuthHeaders> => {
    if (!authenticated || !user) {
      throw new Error("Not authenticated. Please sign in.");
    }

    // ── OAuth user: use Privy access token ────────────────────────────────
    const isOAuthUser =
      !user.wallet &&
      (user.github || user.google || user.email);

    if (isOAuthUser) {
      const token = await getAccessToken();
      if (!token) throw new Error("Failed to get Privy access token.");
      return buildPrivyHeaders(token, user.id);
    }

    // ── Wallet user: prefer embedded wallet → external wallet ─────────────
    const embeddedWallet = wallets.find((w) => (w as any).walletClientType === "privy");
    const externalWallet = wallets.find((w) => (w as any).walletClientType !== "privy");
    const activeWallet = embeddedWallet ?? externalWallet;

    if (activeWallet) {
      const address = activeWallet.address;
      // Privy wallets expose signMessage
      const signFn = async (msg: Uint8Array) => {
        const result = await (activeWallet as any).signMessage({ message: msg });
        return result;
      };
      return buildWalletHeaders(address, signFn);
    }

    // ── Fallback: try Privy token even for wallet users ───────────────────
    const token = await getAccessToken();
    if (token) return buildPrivyHeaders(token, user.id);

    throw new Error("No signing method available. Connect a wallet.");
  }, [authenticated, user, getAccessToken, wallets]);
}

// ─── Hook: useCurrentIdentity ─────────────────────────────────────────────────

/**
 * Returns the current user's canonical identity for display/API use.
 */
export function useCurrentIdentity() {
  const { user, authenticated } = usePrivy();
  const { wallets } = useWallets();

  if (!authenticated || !user) {
    return { address: null, displayName: null, authMethod: null as null | "wallet" | "github" | "google" };
  }

  const wallet = wallets[0];
  const address = wallet?.address ?? null;

  const short = address
    ? `${address.slice(0, 6)}...${address.slice(-4)}`
    : null;

  const displayName =
    user.github?.username
      ? `@${user.github.username}`
      : user.google?.email
      ? user.google.email
      : user.email?.address
      ? user.email.address
      : short;

  const authMethod: "wallet" | "github" | "google" | null = user.github
    ? "github"
    : user.google
    ? "google"
    : "wallet";

  return { address, displayName, authMethod, privyUser: user };
}