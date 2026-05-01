"use client"

import React, { useEffect, useState } from 'react'
import Link from 'next/link'
import { Button } from '@/components/ui/button'
import { useRouter } from 'next/navigation'
import { useWallet } from '@solana/wallet-adapter-react'
import { WalletMultiButton } from '@solana/wallet-adapter-react-ui'
import { Bot } from 'lucide-react'

export function LandingHeader() {
  const router = useRouter()
  const { publicKey } = useWallet()
  const [mounted, setMounted] = useState(false)

  useEffect(() => {
    setMounted(true)
  }, [])

  const connected = !!publicKey
  const activeAddress = publicKey ? publicKey.toBase58() : undefined
  const shortAddr = activeAddress ? `${activeAddress.slice(0, 6)}...${activeAddress.slice(-4)}` : null
  const displayName = shortAddr

  return (
    <header className="fixed top-0 w-full z-50 bg-background/80 backdrop-blur-md border-b border-border">
      <nav className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 h-16 flex items-center justify-between">
        <Link href="/" className="flex items-center gap-2 hover:opacity-80 transition-opacity">
          <div className="w-10 h-10 rounded-lg bg-gradient-to-br from-primary to-secondary flex items-center justify-center">
              <Bot className="text-primary-foreground" size={20} />
            </div>
            <div>
              <h1 className="font-bold text-lg text-sidebar-foreground">Synth</h1>
            </div>
        </Link>

        <div className="hidden md:flex items-center gap-8">
          <a href="#features" className="text-sm text-foreground/70 hover:text-foreground transition-colors">
            Features
          </a>
          <a href="#security" className="text-sm text-foreground/70 hover:text-foreground transition-colors">
            Security
          </a>
          <a href="#" className="text-sm text-foreground/70 hover:text-foreground transition-colors">
            Docs
          </a>
          {connected && (
            <Link href="/dashboard" className="text-sm text-foreground/70 hover:text-foreground transition-colors">
              Dashboard
            </Link>
          )}
        </div>

        <div className="flex items-center gap-3">
          {connected && (
            <span className="hidden sm:block text-xs font-mono text-muted-foreground bg-muted/30 px-3 py-1.5 rounded-full border border-border/50">
              {displayName}
            </span>
          )}

          {!connected ? (
            mounted ? (
              <WalletMultiButton className="bg-primary hover:bg-primary/90 text-primary-foreground" />
            ) : (
              <Button className="bg-primary hover:bg-primary/90 text-primary-foreground" disabled>
                Connect Wallet
              </Button>
            )
          ) : (
            <Button
              onClick={() => router.push('/dashboard')}
              className="bg-primary hover:bg-primary/90 text-primary-foreground"
            >
              Open App
            </Button>
          )}
        </div>
      </nav>
    </header>
  )
}