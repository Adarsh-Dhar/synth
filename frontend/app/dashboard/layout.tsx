"use client"

import React, { useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { usePrivy } from '@privy-io/react-auth'
import { Sidebar } from '@/components/sidebar'

export default function DashboardLayout({
  children,
}: {
  children: React.ReactNode
}) {
  const { authenticated, ready } = usePrivy()
  const router = useRouter()

  // Redirect to landing if not authenticated via Privy
  useEffect(() => {
    if (!ready) return
    if (!authenticated) {
      const t = setTimeout(() => {
        if (!authenticated) router.push('/')
      }, 300)
      return () => clearTimeout(t)
    }
  }, [authenticated, ready, router])

  return (
    <div className="flex h-screen">
      <Sidebar />
      <main className="flex-1 overflow-auto md:ml-64">
        {children}
      </main>
    </div>
  )
}