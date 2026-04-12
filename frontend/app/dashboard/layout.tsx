"use client"

import React, { useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { useWallet } from '@solana/wallet-adapter-react'
import { Sidebar } from '@/components/sidebar'

export default function DashboardLayout({
  children,
}: {
  children: React.ReactNode
}) {
  const { publicKey } = useWallet()
  const router = useRouter()
  const connected = !!publicKey

  // Redirect to landing if wallet disconnected
  useEffect(() => {
    if (!connected) {
      // Small delay so wallet adapter can hydrate before we redirect
      const t = setTimeout(() => {
        if (!publicKey) router.push('/')
      }, 800)
      return () => clearTimeout(t)
    }
  }, [connected, publicKey, router])

  return (
    <div className="flex h-screen">
      <Sidebar />
      <main className="flex-1 overflow-auto md:ml-64">
        {children}
      </main>
    </div>
  )
}