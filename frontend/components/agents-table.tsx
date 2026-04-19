"use client"

import React, { useState } from 'react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import Link from 'next/link'
import { Settings2, Play, Square, Loader2 } from 'lucide-react'
import { Agent } from '@/lib/api'
import { AgentsTableProps } from '@/lib/types'
import { useUser } from '@/lib/user-context'
import { getWalletAuthHeaders } from '@/lib/auth/client'
import { GoldRushSecurityBadge } from '@/components/goldrush-security-badge'
// Solana integration only; wallet gating removed

// ── Status styles ─────────────────────────────────────────────────────────────

const STATUS_STYLES: Record<string, string> = {
  RUNNING:  'bg-green-500/20 text-green-300 border-green-500/30',
  STARTING: 'bg-blue-500/20 text-blue-300 border-blue-500/30',
  STOPPING: 'bg-yellow-500/20 text-yellow-300 border-yellow-500/30',
  STOPPED:  'bg-gray-500/20 text-gray-300 border-gray-500/30',
  ERROR:    'bg-red-500/20 text-red-300 border-red-500/30',
  PAUSED:   'bg-yellow-500/20 text-yellow-300 border-yellow-500/30',
  REVOKED:  'bg-red-500/20 text-red-300 border-red-500/30',
  EXPIRED:  'bg-gray-500/20 text-gray-300 border-gray-500/30',
}

// ── Intent display helpers ────────────────────────────────────────────────────

interface BotIntent {
  chain?:          string;
  network?:        string;
  strategy?:       string;
  execution_model?: string;
  bot_name?:       string;
  bot_type?:       string;
}

function strategyIcon(strategy?: string): string {
  const s = (strategy ?? "").toLowerCase();
  if (!s) return "🤖";
  if (s.includes("arbitrage"))    return "⚡";
  if (s.includes("snip"))        return "🎯";
  if (s.includes("sentiment"))   return "📰";
  if (s.includes("whale"))       return "🐋";
  if (s.includes("perp") || s.includes("funding")) return "📈";
  if (s.includes("dca") || s.includes("grid"))     return "📊";
  if (s.includes("yield") || s.includes("bridge")) return "🌉";
  if (s.includes("news"))        return "📰";
  if (s.includes("mev"))         return "🛡️";
  return "🤖";
}

function strategyLabel(strategy?: string): string {
  const s = (strategy ?? "").toLowerCase();
  if (!s) return "Custom Bot";
  const labels: Record<string, string> = {
    arbitrage:    "Arbitrage",
    sniping:      "Sniper",
    sentiment:    "Sentiment",
    whale_mirror: "Whale Mirror",
    dca:          "DCA",
    grid:         "Grid",
    perp:         "Perp/Funding",
    yield:        "Yield Arb",
    mev_intent:   "MEV-Protected",
    scalper:      "HF Scalper",
    news_reactive:"News Trader",
    rebalancing:  "Rebalancer",
    ta_scripter:  "TA Trader",
  };
  return labels[s] ?? s.replace(/_/g, " ");
}

function chainLabel(intent?: BotIntent | null): { label: string; color: string } {
  if (!intent) return { label: "◎ Solana", color: "text-yellow-400" };
  const nets: Record<string, { label: string; color: string }> = {
    devnet: { label: "◎ Solana Devnet", color: "text-blue-400" },
    "mainnet-beta": { label: "◎ Solana", color: "text-yellow-400" },
  };
  return nets[intent.network ?? ""] ?? { label: "◎ Solana", color: "text-yellow-400" };
}

function execModelBadge(model?: string): string | null {
  if (!model) return null;
  const m: Record<string, string> = {
    polling:   "REST",
    websocket: "WSS",
    agentic:   "AI",
  };
  return m[model] ?? model;
}

// ── API helpers ───────────────────────────────────────────────────────────────

async function callWorkerAction(agentId: string, action: 'start' | 'stop', authHeaders: HeadersInit) {
  const res = await fetch(`/api/agents/${agentId}/${action}`, {
    method: 'POST',
    headers: {
      ...(authHeaders ?? {}),
    },
  })
  if (!res.ok) {
    const body = await res.json().catch(() => ({}))
    throw new Error((body as { error?: string }).error ?? `HTTP ${res.status}`)
  }
  return res.json()
}

// ── Component ─────────────────────────────────────────────────────────────────

export function AgentsTable({ agents, onRefresh }: AgentsTableProps) {
  const { walletSigner } = useUser()
  const [loadingId, setLoadingId] = useState<string | null>(null)
  const [errors, setErrors]       = useState<Record<string, string>>({})
  const handleToggle = async (agent: Agent) => {
    setLoadingId(agent.id)
    setErrors(prev => { const n = { ...prev }; delete n[agent.id]; return n })
    try {
      const action = agent.status === 'RUNNING' ? 'stop' : 'start'
      const authHeaders = await getWalletAuthHeaders(walletSigner)
      await callWorkerAction(agent.id, action, authHeaders)
      setTimeout(() => onRefresh?.(), 800)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      setErrors(prev => ({ ...prev, [agent.id]: msg }))
    } finally {
      setLoadingId(null)
    }
  }

  const isTerminal = (status: string) => status === 'REVOKED' || status === 'EXPIRED'
  const canToggle  = (status: string) => !isTerminal(status) && status !== 'STARTING' && status !== 'STOPPING'

  return (
    <div className="overflow-x-auto">
      <table className="w-full">
        <thead>
          <tr className="border-b border-border bg-muted/30">
            {['Name', 'Status', 'Strategy', 'Configuration', 'Signals', 'Actions'].map(h => (
              <th key={h} className="px-6 py-4 text-left text-sm font-semibold text-muted-foreground">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {agents.map(agent => {
            const isLoading  = loadingId === agent.id
            const toggleable = canToggle(agent.status)
            const isRunning  = agent.status === 'RUNNING'
            const errMsg     = errors[agent.id]

            // Extract intent from configuration
            const cfg    = agent.configuration as Record<string, unknown> | null
            const intent = (cfg?.intent ?? null) as BotIntent | null
            const chain  = chainLabel(intent)
            const model  = execModelBadge(intent?.execution_model ?? 'polling')

            return (
              <tr key={agent.id} className="border-b border-border hover:bg-muted/20 transition-colors">

                {/* Name */}
                <td className="px-6 py-4">
                  <Link
                    href={`/dashboard/agents/${agent.id}`}
                    className="font-semibold text-foreground hover:text-primary transition-colors"
                  >
                    {agent.name}
                  </Link>
                  {errMsg && (
                    <p className="text-xs text-red-400 mt-1 max-w-xs truncate" title={errMsg}>
                      ⚠ {errMsg}
                    </p>
                  )}
                </td>

                {/* Status */}
                <td className="px-6 py-4">
                  <div className="flex items-center gap-2">
                    <Badge variant="default" className={STATUS_STYLES[agent.status] ?? STATUS_STYLES.STOPPED}>
                      {agent.status}
                    </Badge>
                    {(agent.status === 'STARTING' || agent.status === 'STOPPING') && (
                      <Loader2 size={12} className="animate-spin text-muted-foreground" />
                    )}
                  </div>
                </td>

                {/* Strategy — NEW: shows intent data ─────────────────────── */}
                <td className="px-6 py-4">
                  <div className="flex flex-col gap-1">
                    {intent?.strategy ? (
                      <span className="text-sm font-medium text-foreground">
                        {strategyIcon(intent.strategy)}&nbsp;{strategyLabel(intent.strategy)}
                      </span>
                    ) : (
                      <span className="text-sm text-muted-foreground italic">—</span>
                    )}
                    <div className="flex items-center gap-1.5 flex-wrap">
                      <span className={`text-xs font-mono ${chain.color}`}>{chain.label}</span>
                      {model && (
                        <span className="text-[10px] bg-muted/30 border border-border rounded px-1.5 py-0.5 text-muted-foreground font-semibold">
                          {model}
                        </span>
                      )}
                    </div>
                  </div>
                </td>

                {/* Configuration summary */}
                <td className="px-6 py-4 text-sm text-muted-foreground">
                  {cfg ? (
                    <div className="flex flex-col gap-0.5">
                      {typeof cfg.baseToken === 'string' && typeof cfg.targetToken === 'string' && (
                        <span className="font-mono text-xs text-foreground/70">
                          {cfg.baseToken + '→' + cfg.targetToken}
                        </span>
                      )}
                      {cfg.simulationMode !== undefined && (
                        <span className={`text-[10px] font-semibold ${cfg.simulationMode ? 'text-yellow-400' : 'text-red-400'}`}>
                          {cfg.simulationMode ? '🧪 Simulation' : '⚡ Live'}
                        </span>
                      )}
                      {!cfg.baseToken && !cfg.targetToken && (
                        <span className="italic text-muted-foreground/50 text-xs">configured</span>
                      )}
                    </div>
                  ) : (
                    <span className="italic text-muted-foreground/50">no config</span>
                  )}
                </td>

                {/* Actions */}
                <td className="px-6 py-4">
                  <div className="flex flex-col items-start gap-2">
                    <GoldRushSecurityBadge verified compact />
                    {Boolean((cfg?.privateExecution ?? cfg?.privateExecutionEnabled) as boolean | undefined) && (
                      <span className="text-[10px] font-semibold px-2 py-0.5 rounded border border-cyan-500/30 text-cyan-300 bg-cyan-500/10">
                        Private Execution
                      </span>
                    )}
                  </div>
                </td>

                {/* Actions */}
                <td className="px-6 py-4">
                  <div className="flex items-center gap-2">
                    {toggleable && (
                      <Button
                        size="sm"
                        variant={isRunning ? 'destructive' : 'outline'}
                        onClick={() => handleToggle(agent)}
                        disabled={isLoading}
                        className={
                          isRunning
                            ? 'bg-red-500/10 text-red-400 border border-red-500/30 hover:bg-red-500/20'
                            : 'border-green-500/30 text-green-400 hover:bg-green-500/10'
                        }
                      >
                        {isLoading ? (
                          <Loader2 size={13} className="animate-spin" />
                        ) : isRunning ? (
                          <><Square size={13} className="mr-1.5" />Stop</>
                        ) : (
                          <><Play size={13} className="mr-1.5" />Start</>
                        )}
                      </Button>
                    )}
                    <Link href={`/dashboard/agents/${agent.id}`}>
                      <Button size="sm" variant="outline" className="border-border hover:bg-muted">
                        <Settings2 size={14} className="mr-1.5" />
                        Manage
                      </Button>
                    </Link>
                  </div>
                </td>

              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}