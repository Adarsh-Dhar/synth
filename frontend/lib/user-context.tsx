"use client";

/**
 * frontend/lib/user-context.tsx  (updated)
 *
 * Resolves the Synth User record from EITHER:
 *   • A connected Solana wallet (existing flow)
 *   • A Privy OAuth user (GitHub / Google)
 *
 * Components that call useUser() are unchanged — they still get { user, loading, walletSigner }.
 * The walletSigner is populated from Privy's Solana wallet where available.
 */

import React, {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  useCallback,
  type ReactNode,
} from "react";
import { usePrivy } from "@privy-io/react-auth";
import { useWallets } from "@privy-io/react-auth/solana";
import { useWallet } from "@solana/wallet-adapter-react";
import type { WalletSigner } from "@/lib/auth/client";

// ── Types ─────────────────────────────────────────────────────────────────────

interface User {
  id: string;
  walletAddress: string;
  email?: string | null;
  subscriptionTier?: string;
  plan?: string;
  planStartedAt?: string | null;
  planExpiresAt?: string | null;
  monthlyUsageUnits?: number;
}

interface UserContextType {
  user: User | null;
  loading: boolean;
  disconnect: () => void;
  walletSigner: WalletSigner;
}

const UserContext = createContext<UserContextType | null>(null);

// ── Sync helper ───────────────────────────────────────────────────────────────

async function syncUser(
  walletAddress: string,
  extraHeaders: Record<string, string> = {}
): Promise<User> {
  const res = await fetch("/api/users/sync", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...extraHeaders },
    body: JSON.stringify({ walletAddress }),
  });
  if (!res.ok) throw new Error("Failed to sync user");
  return res.json() as Promise<User>;
}

// ── Provider ──────────────────────────────────────────────────────────────

export function UserProvider({ children }: { children: ReactNode }) {
  const { user: privyUser, authenticated, logout: privyLogout } = usePrivy();
  const { wallets: privySolanaWallets } = useWallets();

  // Legacy wallet adapter (used by existing components)
  const { publicKey, signMessage } = useWallet();

  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(false);

  // ── Resolve wallet address ─────────────────────────────────────────────────

  // Priority: Privy embedded/external Solana wallet → legacy adapter
  const privySolanaAddress =
    privySolanaWallets?.[0]?.address ?? null;
  const legacyAddress = publicKey?.toBase58() ?? null;
  const walletAddress = privySolanaAddress ?? legacyAddress;

  // ── Build walletSigner for existing auth helpers ───────────────────────────

  const privyWallet = privySolanaWallets[0];

  const walletSigner: WalletSigner = useMemo(() => {
    if (privyWallet) {
      return {
        publicKey: { toBase58: () => privyWallet.address },
        signMessage: async (msg: Uint8Array) => {
          // Privy wallet signMessage returns SolanaSignMessageOutput
          const result = await (privyWallet as any).signMessage({ message: msg });
          // Extract signature from the output - it could be an array or object
          if (Array.isArray(result)) {
            return result[0]?.signature || new Uint8Array();
          }
          return (result as any)?.signature || new Uint8Array();
        },
      };
    }
    // Fallback to legacy adapter
    return { publicKey, signMessage };
  }, [privyWallet, publicKey, signMessage]);

  // ── Sync with backend when identity changes ────────────────────────────────

  useEffect(() => {
    if (!authenticated || !privyUser) {
      setUser(null);
      return;
    }

    const addr =
      walletAddress ??
      // OAuth-only users get a synthetic Privy address
      `privy:${privyUser.id}`;

    setLoading(true);
    syncUser(addr)
      .then(setUser)
      .catch((err) => {
        console.error("[UserProvider] sync error:", err);
        setUser(null);
      })
      .finally(() => setLoading(false));
  }, [authenticated, privyUser?.id, walletAddress]);

  const disconnect = useCallback(async () => {
    setUser(null);
    try {
      await privyLogout();
    } catch {
      return;
    }
  }, [privyLogout]);

  return (
    <UserContext.Provider value={{ user, loading, disconnect, walletSigner }}>
      {children}
    </UserContext.Provider>
  );
}

export function useUser() {
  const ctx = useContext(UserContext);
  if (!ctx) throw new Error("useUser must be used within UserProvider");
  return ctx;
}