"use client"

/**
 * frontend/components/sidebar.tsx
 *
 * Updated to include the Bot Configurator nav item.
 */

import React, { useState } from 'react'
import Link from 'next/link'
import { usePathname, useRouter } from 'next/navigation'
import {
  Bot, BarChart3, Zap, Wallet, Menu, X, LogOut,
  ShieldCheck, ShieldOff, Settings2,
} from 'lucide-react'

import { cn } from '@/lib/utils'
import { useWallet } from '@solana/wallet-adapter-react'

export function Sidebar() {
  const pathname = usePathname()
  const router   = useRouter()
  const [isOpen, setIsOpen] = useState(false)

  const { publicKey, disconnect } = useWallet()

  const connected = !!publicKey
  const displayAddr = publicKey ? publicKey.toBase58() : null
  const shortAddr = displayAddr ? `${displayAddr.slice(0, 8)}...${displayAddr.slice(-4)}` : null
  const displayName = shortAddr

  const handleDisconnect = async () => {
    try { await disconnect?.() } catch (e) { /* ignore */ }
    router.push('/')
  }

  const navItems = [
    { href: '/dashboard',                      label: 'Dashboard',        icon: BarChart3 },
    { href: '/dashboard/deploy',               label: 'Deploy Agent',     icon: Zap },
    { href: '/dashboard/agents',               label: 'Active Agents',    icon: Bot },
    { href: '/dashboard/bridge',               label: 'Bridge/Wallet',    icon: Wallet },
    {
      href:   '/dashboard/bot-configurator',
      label:  'Bot Configurator',
      icon:   Settings2,
      badge:  'NEW',
      badgeColor: 'bg-cyan-500/20 text-cyan-400',
    },
  ]

  return (
    <>
      {/* Mobile toggle */}
      <button
        onClick={() => setIsOpen(!isOpen)}
        className="fixed top-4 left-4 z-50 md:hidden p-2 rounded-lg bg-card border border-border hover:bg-muted"
      >
        {isOpen ? <X size={20} /> : <Menu size={20} />}
      </button>

      {/* Sidebar */}
      <aside
        className={cn(
          'fixed left-0 top-0 h-screen w-64 bg-sidebar border-r border-sidebar-border flex flex-col transition-transform duration-300 z-40',
          'md:translate-x-0',
          isOpen ? 'translate-x-0' : '-translate-x-full md:translate-x-0'
        )}
      >
        {/* Logo */}
        <div className="p-6 border-b border-sidebar-border">
          <Link href="/" className="flex items-center gap-2" onClick={() => setIsOpen(false)}>
            <div className="w-10 h-10 rounded-lg bg-gradient-to-br from-primary to-secondary flex items-center justify-center">
              <Bot className="text-primary-foreground" size={20} />
            </div>
            <div>
              <h1 className="font-bold text-lg text-sidebar-foreground">Synth</h1>
              <p className="text-xs text-muted-foreground">AI Trading</p>
            </div>
          </Link>
        </div>

        {/* Navigation */}
        <nav className="flex-1 overflow-y-auto px-4 py-6 space-y-1">
          {navItems.map((item) => {
            const Icon     = item.icon
            const isActive = pathname === item.href
            return (
              <Link
                key={item.href}
                href={item.href}
                onClick={() => setIsOpen(false)}
                className={cn(
                  'flex items-center gap-3 px-4 py-3 rounded-lg transition-all duration-200',
                  isActive
                    ? 'bg-sidebar-primary text-sidebar-primary-foreground'
                    : 'text-sidebar-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground'
                )}
              >
                <Icon size={18} />
                <span className="font-medium text-sm">{item.label}</span>
                {'badge' in item && item.badge && (
                  <span className={cn(
                    'ml-auto text-[10px] px-1.5 py-0.5 rounded font-semibold',
                    (item as { badgeColor?: string }).badgeColor ?? 'bg-primary/20 text-primary'
                  )}>
                    {item.badge}
                  </span>
                )}
              </Link>
            )
          })}
        </nav>

        {/* Footer */}
        <div className="p-4 border-t border-sidebar-border space-y-3">
          {connected && displayName && (
            <div className="px-3 py-2.5 rounded-lg bg-muted/20 border border-border/50">
              <p className="text-xs text-muted-foreground mb-0.5">Connected Identity</p>
              <p className="text-sm font-mono text-foreground truncate">{displayName}</p>
            </div>
          )}

          {/* Removed Solana AutoSign UI — Solana wallets use explicit user approvals */}

          <button
            onClick={handleDisconnect}
            className="w-full flex items-center gap-2 px-3 py-2.5 rounded-lg text-muted-foreground hover:text-foreground hover:bg-muted/30 transition-colors text-sm"
          >
            <LogOut size={16} />
            <span>Disconnect</span>
          </button>
        </div>
      </aside>

      {/* Mobile overlay */}
      {isOpen && (
        <div
          className="fixed inset-0 bg-black/50 z-30 md:hidden"
          onClick={() => setIsOpen(false)}
        />
      )}
    </>
  )
}