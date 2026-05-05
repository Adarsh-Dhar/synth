"use client";

/**
 * frontend/lib/providers.tsx  (updated — Privy-first, no legacy wallet adapter)
 *
 * Provider stack (outermost → innermost):
 *   QueryClientProvider
 *   PrivyProvider           ← handles wallet + GitHub + Google auth (no legacy adapter UI)
 *     UserProvider          ← resolves wallet from Privy Solana wallets
 *       DodoOverlayProvider
 *       {children}
 *
 * NOTE: Legacy @solana/wallet-adapter-react removed from main provider tree.
 * Components that still need it (e.g., portfolio-panel, signing-relay-consumer)
 * should import it locally or migrate to @privy-io/react-auth/solana.
 *
 * No more Phantom popup!
 * Install:
 *   npm install @privy-io/react-auth @privy-io/server-auth
 */

import React, { PropsWithChildren } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { PrivyProvider } from "@/lib/privy-provider";
import { UserProvider } from "@/lib/user-context";
import { DodoOverlayProvider } from "@/components/dodo-overlay-provider";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { retry: 1, staleTime: 30_000 },
  },
});

export default function Providers({ children }: PropsWithChildren) {
  return (
    <QueryClientProvider client={queryClient}>
      {/*
       * PrivyProvider is outermost so that Privy's usePrivy() hook is
       * available everywhere for wallet + OAuth authentication.
       */}
      <PrivyProvider>
        <UserProvider>
          <DodoOverlayProvider />
          {children}
        </UserProvider>
      </PrivyProvider>
    </QueryClientProvider>
  );
}