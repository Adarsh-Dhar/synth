"use client"

import React, { createContext, useContext, useEffect, useMemo, useState, ReactNode } from 'react'
import { useWallet } from '@solana/wallet-adapter-react'
import { getWalletAuthHeaders, type WalletSigner } from '@/lib/auth/client'

interface User {
  id: string
  walletAddress: string
  email?: string | null
}

interface UserContextType {
  user: User | null
  loading: boolean
  disconnect: () => void
  walletSigner: WalletSigner
}

const UserContext = createContext<UserContextType | null>(null)

// Sync the wallet address with our backend DB and return the User record.
async function syncUser(walletSigner: WalletSigner, walletAddress: string): Promise<User> {
  const authHeaders = await getWalletAuthHeaders(walletSigner)
  const res = await fetch('/api/users/sync', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders },
    body: JSON.stringify({ walletAddress }),
  })
  if (!res.ok) throw new Error('Failed to sync user')
  return res.json()
}

export function UserProvider({ children }: { children: ReactNode }) {
  const { publicKey, signMessage } = useWallet()
  const [user, setUser] = useState<User | null>(null)
  const [loading, setLoading] = useState(false)

  // Prefer the Solana bech32 address when present.
  const walletAddr = publicKey ? publicKey.toBase58() : undefined

  const walletSigner: WalletSigner = useMemo(() => ({
    publicKey,
    signMessage,
  }), [publicKey, signMessage])

  useEffect(() => {
    if (!walletAddr) {
      setUser(null)
      return
    }

    setLoading(true)
    syncUser(walletSigner, walletAddr)
      .then(setUser)
      .catch((err) => {
        console.error('[UserProvider] sync error:', err)
        setUser(null)
      })
      .finally(() => setLoading(false))
  }, [walletAddr, walletSigner])

  const disconnect = () => {
    setUser(null)
  }

  return (
    <UserContext.Provider value={{ user, loading, disconnect, walletSigner }}>
      {children}
    </UserContext.Provider>
  )
}

export function useUser() {
  const ctx = useContext(UserContext)
  if (!ctx) throw new Error('useUser must be used within UserProvider')
  return ctx
}