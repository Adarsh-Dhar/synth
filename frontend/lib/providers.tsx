"use client"

import React, { PropsWithChildren, useMemo } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { ConnectionProvider, WalletProvider } from '@solana/wallet-adapter-react'
import { WalletAdapterNetwork } from '@solana/wallet-adapter-base'
import { PhantomWalletAdapter } from '@solana/wallet-adapter-phantom'
import { clusterApiUrl } from '@solana/web3.js'
import { UserProvider } from '@/lib/user-context'

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { retry: 1, staleTime: 30_000 },
  },
})

export default function Providers({ children }: PropsWithChildren) {
  const network = (process.env.NEXT_PUBLIC_SOLANA_NETWORK as WalletAdapterNetwork) || 'devnet'
  const endpoint = process.env.NEXT_PUBLIC_SOLANA_RPC_URL || clusterApiUrl(network)

  const wallets = useMemo(() => [new PhantomWalletAdapter()], [])

  return (
    <QueryClientProvider client={queryClient}>
      <ConnectionProvider endpoint={endpoint}>
        <WalletProvider wallets={wallets} autoConnect>
          <UserProvider>
            {children}
          </UserProvider>
        </WalletProvider>
      </ConnectionProvider>
    </QueryClientProvider>
  )
}