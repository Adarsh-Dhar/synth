"use client";

/**
 * frontend/lib/providers.tsx  (updated)
 *
 * Add <DodoOverlayProvider /> so the Dodo overlay JS SDK is available
 * app-wide. No other changes from the original file.
 */

import React, { PropsWithChildren, useMemo } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ConnectionProvider, WalletProvider } from "@solana/wallet-adapter-react";
import { WalletAdapterNetwork } from "@solana/wallet-adapter-base";
import { PhantomWalletAdapter } from "@solana/wallet-adapter-phantom";
import { clusterApiUrl } from "@solana/web3.js";
import { UserProvider } from "@/lib/user-context";
import { WalletModalProvider } from "@solana/wallet-adapter-react-ui";
import { DodoOverlayProvider } from "@/components/dodo-overlay-provider";
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

  const wallets = useMemo(() => [new PhantomWalletAdapter()], [network]);

  return (
    <QueryClientProvider client={queryClient}>
      <ConnectionProvider endpoint={endpoint}>
        <WalletProvider wallets={wallets} autoConnect={false}>
          <WalletModalProvider>
            <UserProvider>
              {/* Injects Dodo Overlay JS SDK once globally */}
              <DodoOverlayProvider />
              {children}
            </UserProvider>
          </WalletModalProvider>
        </WalletProvider>
      </ConnectionProvider>
    </QueryClientProvider>
  );
}