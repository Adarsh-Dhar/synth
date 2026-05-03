"use client";

/**
 * frontend/lib/providers.tsx  (updated — adds Privy OAuth)
 *
 * Provider stack (outermost → innermost):
 *   QueryClientProvider
 *   PrivyProvider           ← NEW: handles wallet + GitHub + Google auth
 *     UserProvider          ← updated to use Privy identity
 *       DodoOverlayProvider
 *       {children}
 *
 * NOTE: WalletProvider / ConnectionProvider from @solana/wallet-adapter-react
 * are no longer needed at the app level — Privy's embedded wallet and external
 * Solana wallet connectors replace them. If you still have components that
 * call `useWallet()` directly (the deploy chat, deposit flow, etc.) you can
 * either keep the adapter alongside Privy or migrate them to useSolanaWallets()
 * from @privy-io/react-auth/solana. A thin compatibility shim is included below.
 *
 * Install:
 *   npm install @privy-io/react-auth @privy-io/server-auth
 */

import React, { PropsWithChildren } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { PrivyProvider } from "@/lib/privy-provider";
import { UserProvider } from "@/lib/user-context";
import { DodoOverlayProvider } from "@/components/dodo-overlay-provider";

// ── Keep the Solana wallet adapter for components that still call useWallet() ──
// Remove once those components are migrated to Privy's useSolanaWallets().
import { ConnectionProvider, WalletProvider } from "@solana/wallet-adapter-react";
import { WalletAdapterNetwork } from "@solana/wallet-adapter-base";
import { clusterApiUrl } from "@solana/web3.js";
import { WalletModalProvider } from "@solana/wallet-adapter-react-ui";
import "@solana/wallet-adapter-react-ui/styles.css";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { retry: 1, staleTime: 30_000 },
  },
});

export default function Providers({ children }: PropsWithChildren) {
  const network =
    (process.env.NEXT_PUBLIC_SOLANA_NETWORK as WalletAdapterNetwork) ||
    "mainnet-beta";
  const endpoint =
    process.env.NEXT_PUBLIC_SOLANA_RPC_URL || clusterApiUrl(network);

  const wallets = React.useMemo(() => [], []);

  return (
    <QueryClientProvider client={queryClient}>
      {/*
       * PrivyProvider is outermost so that Privy's usePrivy() hook is
       * available everywhere — including inside the Solana adapter tree.
       */}
      <PrivyProvider>
        {/* Legacy Solana wallet adapter kept for backward compatibility */}
        <ConnectionProvider endpoint={endpoint}>
          <WalletProvider wallets={wallets} autoConnect={false}>
            <WalletModalProvider>
              <UserProvider>
                <DodoOverlayProvider />
                {children}
              </UserProvider>
            </WalletModalProvider>
          </WalletProvider>
        </ConnectionProvider>
      </PrivyProvider>
    </QueryClientProvider>
  );
}