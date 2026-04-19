"use client"

import React, { useEffect, useState } from 'react'
import { DollarSign, TrendingUp, Zap, RefreshCw } from 'lucide-react'
import { StatCard } from '@/components/stat-card'
import { AgentsTable } from '@/components/agents-table'
import { Button } from '@/components/ui/button'
import Link from 'next/link'
import { useUser } from '@/lib/user-context'
import { useWallet } from '@solana/wallet-adapter-react'
import { useRouter } from 'next/navigation'
import { fetchAgents, Agent } from '@/lib/api'
import { getWalletAuthHeaders } from '@/lib/auth/client'

export default function DashboardPage() {
  const { user, loading: userLoading, walletSigner } = useUser()
  const { publicKey } = useWallet()
  const router = useRouter()
  const [agents, setAgents] = useState<Agent[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [refreshing, setRefreshing] = useState(false)

  const connected = !!publicKey

  const loadAgents = async (showRefresh = false) => {
    if (!user) return
    if (showRefresh) setRefreshing(true)
    try {
      const authHeaders = await getWalletAuthHeaders(walletSigner)
      const data = await fetchAgents(authHeaders)
      setAgents(data)
      setError(null)
    } catch {
      setError('Failed to load agents. Check your connection.')
    } finally {
      setLoading(false)
      setRefreshing(false)
    }
  }

  useEffect(() => {
    if (!userLoading && !connected) {
      router.push('/')
    }
  }, [connected, userLoading, router])

  useEffect(() => {
    if (user) loadAgents()
  }, [user])

  const totalAllowance = agents.reduce((s, a) => s + a.spendAllowance, 0)
  const totalPnl = agents.reduce((s, a) => s + a.currentPnl, 0)
  const activeCount = agents.filter((a) => a.status === 'RUNNING').length

  if (userLoading || loading) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <div className="text-center space-y-3">
          <div className="w-8 h-8 border-2 border-primary border-t-transparent rounded-full animate-spin mx-auto" />
          <p className="text-muted-foreground text-sm">Loading dashboard…</p>
        </div>
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-background">
      <div className="sticky top-0 z-30 bg-background border-b border-border">
        <div className="px-6 py-4 lg:px-8 flex items-center justify-between">
          <div>
            <h1 className="text-3xl font-bold text-foreground">Dashboard</h1>
            <p className="text-muted-foreground mt-1">Overview of your AI trading agents</p>
          </div>
          <div className="flex items-center gap-3">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => loadAgents(true)}
              disabled={refreshing}
              className="text-muted-foreground hover:text-foreground"
            >
              <RefreshCw size={16} className={refreshing ? 'animate-spin' : ''} />
            </Button>
            <Link href="/dashboard/deploy">
              <Button className="bg-gradient-to-r from-primary to-secondary hover:opacity-90 text-primary-foreground">
                <Zap size={18} className="mr-2" />
                Deploy New Agent
              </Button>
            </Link>
          </div>
        </div>
      </div>

      <div className="px-6 py-8 lg:px-8 max-w-7xl mx-auto">
        {error && (
          <div className="mb-6 p-4 bg-destructive/10 border border-destructive/30 rounded-lg text-destructive text-sm">
            {error}
          </div>
        )}

        <div className="grid grid-cols-1 md:grid-cols-1 gap-6 mb-8">
          <StatCard
            label="Active Agents"
            value={activeCount}
            subvalue={`of ${agents.length} total`}
            icon={<TrendingUp size={24} />}
          />
        </div>

        <div className="bg-card border border-border rounded-lg overflow-hidden">
          <div className="p-6 border-b border-border">
            <h2 className="text-xl font-bold text-foreground">AI Agents</h2>
            <p className="text-sm text-muted-foreground mt-1">
              Monitor and manage your deployed trading strategies
            </p>
          </div>

          {agents.length === 0 ? (
            <div className="p-12 text-center">
              <div className="w-16 h-16 bg-muted/30 rounded-full flex items-center justify-center mx-auto mb-4">
                <TrendingUp size={32} className="text-muted-foreground" />
              </div>
              <h3 className="font-semibold text-foreground mb-2">No agents deployed yet</h3>
                <p className="text-muted-foreground text-sm mb-6">
                Deploy your first AI trading agent to start automated trading on Solana.
              </p>
              <Link href="/dashboard/deploy">
                <Button className="bg-gradient-to-r from-primary to-secondary hover:opacity-90 text-primary-foreground">
                  <Zap size={16} className="mr-2" />
                  Deploy Your First Agent
                </Button>
              </Link>
            </div>
          ) : (
            <AgentsTable agents={agents} onRefresh={() => loadAgents(true)} />
          )}
        </div>
      </div>
    </div>
  )
}