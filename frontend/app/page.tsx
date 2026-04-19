"use client"

import React from 'react'
import { Button } from '@/components/ui/button'
import { LandingHeader } from '@/components/landing-header'
import { FeatureCard } from '@/components/feature-card'
import Link from 'next/link'
import { ArrowRight, Zap, Lock, GitBranch } from 'lucide-react'
import { useWallet } from '@solana/wallet-adapter-react'
import { WalletMultiButton } from '@solana/wallet-adapter-react-ui'
import { useRouter } from 'next/navigation'
import { useEffect, useState } from 'react'

export default function Home() {
  const { publicKey, connect } = useWallet()
  const router = useRouter()
  const [mounted, setMounted] = useState(false)
  const connected = !!publicKey

  // Auto-redirect if already connected
  useEffect(() => {
    if (connected) {
      // Don't auto-redirect on landing — let the user choose
    }
  }, [connected])

  useEffect(() => {
    setMounted(true)
  }, [])

  const handleConnect = async () => {
    if (connected) {
      router.push('/dashboard')
    }
  }

  return (
    <>
      <LandingHeader />

      {/* Hero Section */}
      <section className="pt-32 pb-20 px-4 sm:px-6 lg:px-8">
        <div className="max-w-4xl mx-auto text-center">
          <div className="inline-flex items-center gap-2 px-4 py-2 rounded-full bg-primary/10 border border-primary/20 mb-8">
            <Zap className="w-4 h-4 text-primary" />
            <span className="text-sm font-medium text-primary">Powered by Solana</span>
          </div>

          <h1 className="text-5xl sm:text-6xl lg:text-7xl font-bold mb-6 leading-tight text-balance">
            Sleep soundly. Let AI trade at{' '}
              <span className="bg-gradient-to-r from-primary to-secondary bg-clip-text text-transparent">
              on Solana.
            </span>
          </h1>

          <p className="text-xl text-foreground/70 mb-8 max-w-2xl mx-auto text-pretty">
            Deploy autonomous AI trading agents powered by cryptographically secure session keys. Trade faster, sleep better, maximize returns.
          </p>

          <div className="flex flex-col sm:flex-row gap-4 justify-center mb-16">
            {!connected ? (
              mounted ? (
                <WalletMultiButton className="bg-primary hover:bg-primary/90 text-primary-foreground px-8 gap-2" />
              ) : (
                <Button
                  size="lg"
                  className="bg-primary hover:bg-primary/90 text-primary-foreground px-8 gap-2"
                  disabled
                >
                  Connect Wallet
                </Button>
              )
            ) : (
              <>
                <Button
                  size="lg"
                  onClick={() => router.push('/dashboard')}
                  className="bg-primary hover:bg-primary/90 text-primary-foreground px-8 gap-2"
                >
                  Open Dashboard
                  <ArrowRight className="w-5 h-5" />
                </Button>
                <Link href="/dashboard">
                  <Button
                    size="lg"
                    variant="outline"
                    className="border-border hover:border-primary/50 hover:bg-primary/5 w-full"
                  >
                    View Dashboard
                  </Button>
                </Link>
              </>
            )}
          </div>

          {/* Stats */}
          <div className="grid grid-cols-3 gap-8 max-w-xl mx-auto text-sm">
            <div>
              <div className="text-2xl font-bold text-primary">100ms</div>
              <div className="text-foreground/60">Block Time</div>
            </div>
            <div>
              <div className="text-2xl font-bold text-secondary">24/7</div>
              <div className="text-foreground/60">Trading</div>
            </div>
            <div>
              <div className="text-2xl font-bold text-primary">0%</div>
              <div className="text-foreground/60">Hidden Fees</div>
            </div>
          </div>
        </div>
      </section>

      {/* Features Section */}
      <section id="features" className="py-20 px-4 sm:px-6 lg:px-8 bg-card/20 border-y border-border">
        <div className="max-w-6xl mx-auto">
          <div className="text-center mb-16">
            <h2 className="text-4xl sm:text-5xl font-bold mb-4">Engineered for Traders</h2>
            <p className="text-lg text-foreground/60 max-w-2xl mx-auto">
              Experience the future of autonomous trading with cutting-edge technology and uncompromising security.
            </p>
          </div>

          <div className="grid md:grid-cols-3 gap-6">
            <FeatureCard
              icon="⚡"
              title="Zero-Click Trading"
              description="Deploy AI agents and watch them execute trades autonomously. No manual intervention required. Your AI works while you sleep."
              gradient={true}
            />
            <FeatureCard
              icon="🔐"
              title="Mathematically Secure"
              description="Session keys with cryptographic guarantees powered by Solana's secure wallet adapters. Set spending limits and time windows — your funds stay safe."
              gradient={true}
            />
            <FeatureCard
              icon="🌉"
              title="Instant Cross-Chain"
              description="Deposit funds across multiple blockchains in seconds. Optimized for Solana's lightning-fast block times."
              gradient={true}
            />
          </div>
        </div>
      </section>

      {/* Security Section */}
      <section id="security" className="py-20 px-4 sm:px-6 lg:px-8">
        <div className="max-w-4xl mx-auto">
          <div className="flex flex-col md:flex-row gap-12 items-center">
            <div className="flex-1">
              <h2 className="text-4xl font-bold mb-6">Enterprise-Grade Security</h2>
              <div className="space-y-4">
                <div className="flex gap-4">
                  <Lock className="w-6 h-6 text-primary flex-shrink-0 mt-1" />
                  <div>
                    <h3 className="font-semibold mb-1">Non-Custodial Design</h3>
                    <p className="text-foreground/70">You retain full custody of your assets. We never hold your funds.</p>
                  </div>
                </div>
                <div className="flex gap-4">
                  <Zap className="w-6 h-6 text-primary flex-shrink-0 mt-1" />
                  <div>
                    <h3 className="font-semibold mb-1">Solana Wallet Adapter</h3>
                    <p className="text-foreground/70">Secure session keys with spending caps and time-based expiration — sign once, trade forever within limits.</p>
                  </div>
                </div>
                <div className="flex gap-4">
                  <GitBranch className="w-6 h-6 text-primary flex-shrink-0 mt-1" />
                  <div>
                    <h3 className="font-semibold mb-1">Blockchain Verified</h3>
                    <p className="text-foreground/70">All trades are cryptographically verified on Solana's high-performance network.</p>
                  </div>
                </div>
              </div>
            </div>

            <div className="flex-1 bg-card/50 border border-border/50 rounded-xl p-8 backdrop-blur-sm">
              <div className="space-y-6">
                <div>
                  <div className="text-sm text-foreground/60 mb-2">Average Trade Execution</div>
                  <div className="text-3xl font-bold text-primary">100ms</div>
                </div>
                <div>
                  <div className="text-sm text-foreground/60 mb-2">Uptime Guarantee</div>
                  <div className="text-3xl font-bold text-secondary">99.9%</div>
                </div>
                <div>
                  <div className="text-sm text-foreground/60 mb-2">Assets Under Management</div>
                  <div className="text-3xl font-bold text-primary">$50M+</div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* CTA */}
      <section className="py-20 px-4 sm:px-6 lg:px-8 bg-gradient-to-br from-primary/10 via-transparent to-secondary/10 border-y border-border">
        <div className="max-w-2xl mx-auto text-center">
          <h2 className="text-4xl font-bold mb-4">Ready to Trade Autonomously?</h2>
            <p className="text-lg text-foreground/70 mb-8">
             Join hundreds of traders using Synth for intelligent, hands-free trading on Solana.
            </p>
          <Button
            size="lg"
            onClick={handleConnect}
            className="bg-primary hover:bg-primary/90 text-primary-foreground px-8"
          >
            {connected ? 'Open Dashboard' : 'Connect Wallet Now'}
          </Button>
        </div>
      </section>

      {/* Footer */}
      <footer className="border-t border-border py-12 px-4 sm:px-6 lg:px-8">
        <div className="max-w-6xl mx-auto">
          <div className="grid md:grid-cols-4 gap-8 mb-8">
            {[
              { title: 'Product', links: ['Features', 'Pricing', 'Docs'] },
              { title: 'Company', links: ['About', 'Blog', 'Careers'] },
              { title: 'Legal', links: ['Privacy', 'Terms', 'Security'] },
              { title: 'Community', links: ['Twitter', 'Discord', 'GitHub'] },
            ].map((col) => (
              <div key={col.title}>
                <h3 className="font-semibold mb-4">{col.title}</h3>
                <ul className="space-y-2 text-sm text-foreground/70">
                  {col.links.map((l) => (
                    <li key={l}><a href="#" className="hover:text-foreground transition-colors">{l}</a></li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
          <div className="border-t border-border pt-8 flex flex-col md:flex-row justify-between items-center text-sm text-foreground/60">
            <div>&copy; 2024 Synth. All rights reserved.</div>
            <div className="flex gap-6 mt-4 md:mt-0">
              {['Security', 'Status', 'Contact'].map((l) => (
                <a key={l} href="#" className="hover:text-foreground transition-colors">{l}</a>
              ))}
            </div>
          </div>
        </div>
      </footer>
    </>
  )
}