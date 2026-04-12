"use client"

import React from 'react'
import Link from 'next/link'
import { Button } from '@/components/ui/button'
import { useRouter } from 'next/navigation'
import { useWallet } from '@solana/wallet-adapter-react'
import { WalletMultiButton } from '@solana/wallet-adapter-react-ui'

export function LandingHeader() {
  const router = useRouter()
  const { publicKey } = useWallet()

  const connected = !!publicKey
  const activeAddress = publicKey ? publicKey.toBase58() : undefined
  const shortAddr = activeAddress ? `${activeAddress.slice(0, 6)}...${activeAddress.slice(-4)}` : null
  const displayName = shortAddr

  return (
    <header className="fixed top-0 w-full z-50 bg-background/80 backdrop-blur-md border-b border-border">
      <nav className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 h-16 flex items-center justify-between">
        <Link href="/" className="flex items-center gap-2 hover:opacity-80 transition-opacity">
          <div className="w-8 h-8 bg-gradient-to-br from-primary to-secondary rounded-lg flex items-center justify-center">
            <span className="text-white font-bold text-sm">A</span>
          </div>
          <span className="font-bold text-lg">Synth</span>
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
            <WalletMultiButton className="bg-primary hover:bg-primary/90 text-primary-foreground" />
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