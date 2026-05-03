"use client";

/**
 * frontend/lib/privy-provider.tsx
 *
 * Wraps the app in Privy's auth provider.
 * Supports: Solana wallets (Phantom, etc.) + GitHub + Google OAuth.
 * GitHub/Google users get an embedded Solana wallet automatically.
 *
 * Required env vars:
 *   NEXT_PUBLIC_PRIVY_APP_ID   — from https://dashboard.privy.io
 *
 * Install: npm install @privy-io/react-auth
 */

import { PrivyProvider as _PrivyProvider } from "@privy-io/react-auth";
import { toSolanaWalletConnectors } from "@privy-io/react-auth/solana";
import type { ReactNode } from "react";

const solanaConnectors = toSolanaWalletConnectors({
  // Show the Solana wallets (Phantom, Backpack, etc.) in the modal
  shouldAutoConnect: false,
});

export function PrivyProvider({ children }: { children: ReactNode }) {
  const appId = process.env.NEXT_PUBLIC_PRIVY_APP_ID;

  if (!appId) {
    // In development without a Privy app ID, skip the provider and render
    // children directly. Remove this guard once you add the env var.
    console.warn(
      "[PrivyProvider] NEXT_PUBLIC_PRIVY_APP_ID is not set. " +
        "OAuth login will be unavailable. " +
        "Set it in .env.local to enable GitHub/Google sign-in."
    );
    return <>{children}</>;
  }

  return (
    <_PrivyProvider
      appId={appId}
      config={{
        // ── Login methods ────────────────────────────────────────────────
        loginMethods: ["wallet", "github", "google"],

        // ── Appearance ───────────────────────────────────────────────────
        appearance: {
          theme: "dark",
          accentColor: "#F31E2C",   // Synth crimson
          logo: "/icon-dark-32x32.png",
          landingHeader: "Sign in to Synth",
          loginMessage: "Connect your wallet or sign in with GitHub/Google",
          showWalletLoginFirst: true,
          walletChainType: "solana-only",
        },

        // ── Embedded wallets (auto-created for OAuth users) ───────────────
        embeddedWallets: {
          solana: {
            createOnLogin: "users-without-wallets",
          },
          showWalletUIs: true,
        },

        // ── External wallet connectors ───────────────────────────────────
        externalWallets: solanaConnectors ? {
          solana: { connectors: solanaConnectors },
        } : undefined,
      }}
    >
      {children}
    </_PrivyProvider>
  );
}