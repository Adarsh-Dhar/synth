"use client"

import React, { useEffect, useState, useCallback, useRef } from 'react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { PnLChart } from '@/components/pnl-chart'
import {
  ChevronLeft, Play, Square, Trash2, RefreshCw, Loader2,
} from 'lucide-react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'

// ── Types ─────────────────────────────────────────────────────────────────────

interface AgentDetail {
  id:            string
  name:          string
  status:        string
  configuration: Record<string, unknown> | null
  createdAt:     string
  updatedAt:     string
  files:         { id: string; filepath: string; language: string }[]
  tradeLogs:     TradeLogEntry[]
}

interface TradeLogEntry {
  id:              string
  txHash:          string
  tokenIn:         string
  tokenOut:        string
  amountIn:        string
  amountOut:       string
  profitUsd:       string
  executionTimeMs: number
  createdAt:       string
}

interface TerminalEntry {
  line:  string
  level: 'stdout' | 'stderr'
  ts:    number
}

interface PnLDataPoint {
  time: string
  value: number
}

// ── Status helpers ────────────────────────────────────────────────────────────

const STATUS_COLOR: Record<string, string> = {
  RUNNING:  'bg-green-500/20 text-green-300 border-green-500/30',
  STARTING: 'bg-blue-500/20 text-blue-300 border-blue-500/30',
  STOPPING: 'bg-yellow-500/20 text-yellow-300 border-yellow-500/30',
  STOPPED:  'bg-gray-500/20 text-gray-300 border-gray-500/30',
  ERROR:    'bg-red-500/20 text-red-300 border-red-500/30',
}

// ── API helpers ───────────────────────────────────────────────────────────────

async function callWorker(agentId: string, action: 'start' | 'stop') {
  const res = await fetch(`/api/agents/${agentId}/${action}`, { method: 'POST' })
  const raw = await res.text()
  let data: { error?: string } = {}
  try {
    data = raw ? JSON.parse(raw) as { error?: string } : {}
  } catch {
    data = {
      error: raw
        ? `Invalid response from ${action} API: ${raw.slice(0, 120)}`
        : `Empty response from ${action} API`,
    }
  }

  if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`)
  return data
}

async function fetchAgentDetail(agentId: string): Promise<AgentDetail> {
  const res = await fetch(`/api/agents/${agentId}`)
  if (!res.ok) throw new Error('Agent not found')
  return res.json()
}

async function fetchTerminalLogs(agentId: string, since?: number): Promise<TerminalEntry[]> {
  const url = new URL(`/api/agents/${agentId}/terminal-logs`, window.location.origin)
  if (since) url.searchParams.set('since', String(since))
  const res = await fetch(url.toString())
  if (!res.ok) return []
  const data = await res.json()
  return data.entries ?? []
}

// ── Live Terminal component ───────────────────────────────────────────────────

function LiveTerminal({ agentId, running }: { agentId: string; running: boolean }) {
  const [lines, setLines]         = useState<TerminalEntry[]>([])
  const sinceRef                  = useRef<number>(0)
  const bottomRef                 = useRef<HTMLDivElement>(null)
  const intervalRef               = useRef<ReturnType<typeof setInterval> | null>(null)

  // Initial load
  useEffect(() => {
    fetchTerminalLogs(agentId).then((entries) => {
      setLines(entries)
      if (entries.length > 0) sinceRef.current = entries[entries.length - 1].ts
    })
  }, [agentId])

  // Poll for new lines when running
  useEffect(() => {
    if (!running) {
      if (intervalRef.current) clearInterval(intervalRef.current)
      return
    }
    intervalRef.current = setInterval(async () => {
      const newEntries = await fetchTerminalLogs(agentId, sinceRef.current)
      if (newEntries.length > 0) {
        setLines((prev) => [...prev, ...newEntries].slice(-500))
        sinceRef.current = newEntries[newEntries.length - 1].ts
      }
    }, 2000)
    return () => { if (intervalRef.current) clearInterval(intervalRef.current) }
  }, [agentId, running])

  // Auto-scroll
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [lines])

  const fmtTime = (ts: number) => {
    const d = new Date(ts)
    return [d.getHours(), d.getMinutes(), d.getSeconds()]
      .map((n) => String(n).padStart(2, '0'))
      .join(':')
  }

  return (
    <div className="bg-card border border-border rounded-lg overflow-hidden flex flex-col h-[500px]">
      <div className="bg-muted/30 border-b border-border px-4 py-3 flex items-center justify-between">
        <h3 className="text-sm font-semibold">Live Terminal</h3>
        <div className="flex items-center gap-2">
          <span className="text-xs text-muted-foreground">{lines.length} lines</span>
          {running && <span className="w-2 h-2 rounded-full bg-green-400 animate-pulse" />}
        </div>
      </div>

      <div className="flex-1 overflow-y-auto bg-[#0a0d14] p-4 font-mono text-xs space-y-1">
        {lines.length === 0 ? (
          <span className="text-muted-foreground/50">No output yet — start the agent to see logs.</span>
        ) : (
          lines.map((entry, i) => (
            <div key={i} className="flex gap-3 leading-relaxed">
              <span className="text-muted-foreground/40 flex-shrink-0 select-none">
                {fmtTime(entry.ts)}
              </span>
              <span className={entry.level === 'stderr' ? 'text-red-400' : 'text-green-300'}>
                {entry.line}
              </span>
            </div>
          ))
        )}
        <div ref={bottomRef} />
      </div>

      <div className="bg-muted/30 border-t border-border px-4 py-2 text-xs text-muted-foreground flex items-center gap-2">
        {running
          ? <><span className="w-1.5 h-1.5 rounded-full bg-green-400 animate-pulse" />Polling every 2s</>
          : <span className="text-muted-foreground/50">Agent stopped — showing last session logs</span>}
      </div>
    </div>
  )
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function AgentDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const router  = useRouter()
  const { id: agentId } = React.use(params)

  const [agent,             setAgent]             = useState<AgentDetail | null>(null)
  const [loading,           setLoading]           = useState(true)
  const [error,             setError]             = useState<string | null>(null)
  const [actionLoading,     setActionLoading]     = useState(false)
  const [actionError,       setActionError]       = useState<string | null>(null)
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false)

  const loadAgent = useCallback(async () => {
    try {
      setAgent(await fetchAgentDetail(agentId))
      setError(null)
    } catch {
      setError('Agent not found')
    } finally {
      setLoading(false)
    }
  }, [agentId])

  // Initial load + refresh every 5 s while STARTING/STOPPING
  useEffect(() => {
    loadAgent()
  }, [loadAgent])

  useEffect(() => {
    if (!agent) return
    const transitioning = agent.status === 'STARTING' || agent.status === 'STOPPING'
    if (!transitioning) return
    const t = setInterval(loadAgent, 3000)
    return () => clearInterval(t)
  }, [agent, loadAgent])

  const handleToggle = async () => {
    if (!agent) return
    setActionLoading(true)
    setActionError(null)
    try {
      const action = agent.status === 'RUNNING' ? 'stop' : 'start'
      await callWorker(agentId, action)
      setTimeout(loadAgent, 800)
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err))
    } finally {
      setActionLoading(false)
    }
  }

  const handleDelete = async () => {
    setActionLoading(true)
    try {
      const res = await fetch(`/api/agents/${agentId}`, { method: 'DELETE' })
      if (!res.ok) throw new Error('Delete failed')
      router.push('/dashboard')
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err))
      setActionLoading(false)
    }
  }

  // ── Render ──────────────────────────────────────────────────────────────────

  if (loading) return (
    <div className="min-h-screen bg-background flex items-center justify-center">
      <div className="w-8 h-8 border-2 border-primary border-t-transparent rounded-full animate-spin" />
    </div>
  )

  if (error || !agent) return (
    <div className="min-h-screen bg-background flex items-center justify-center text-center">
      <div>
        <h1 className="text-2xl font-bold mb-2">Agent Not Found</h1>
        <Link href="/dashboard">
          <Button variant="outline" className="mt-4">Back to Dashboard</Button>
        </Link>
      </div>
    </div>
  )

  const isRunning    = agent.status === 'RUNNING'
  const inTransition = agent.status === 'STARTING' || agent.status === 'STOPPING'
  const cfg          = agent.configuration as Record<string, unknown> | null

  const pnlData = React.useMemo<PnLDataPoint[]>(() => {
    if (!agent.tradeLogs || agent.tradeLogs.length === 0) return []

    const ordered = [...agent.tradeLogs].sort(
      (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
    )

    let cumulative = 0
    const points: PnLDataPoint[] = ordered.map((log) => {
      const delta = Number.parseFloat(String(log.profitUsd ?? '0'))
      cumulative += Number.isFinite(delta) ? delta : 0
      const t = new Date(log.createdAt)
      const time = [t.getHours(), t.getMinutes()]
        .map((n) => String(n).padStart(2, '0'))
        .join(':')
      return { time, value: Number(cumulative.toFixed(4)) }
    })

    return points
  }, [agent.tradeLogs])

  return (
    <div className="min-h-screen bg-background">
      {/* ── Header ── */}
      <div className="sticky top-0 z-30 bg-background border-b border-border">
        <div className="px-6 py-4 lg:px-8 flex items-center justify-between flex-wrap gap-3">
          <div className="flex items-center gap-4">
            <Link href="/dashboard">
              <Button variant="ghost" size="sm">
                <ChevronLeft size={20} className="mr-1" />Back
              </Button>
            </Link>
            <div>
              <h1 className="text-2xl font-bold">{agent.name}</h1>
              <p className="text-muted-foreground text-sm mt-0.5">
                {cfg?.strategy as string ?? 'Custom Agent'}{cfg?.targetPair ? ` · ${cfg.targetPair}` : ''}
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2 flex-wrap">
            {/* Start / Stop */}
            {!inTransition && (
              <Button
                size="sm"
                onClick={handleToggle}
                disabled={actionLoading}
                variant={isRunning ? 'destructive' : 'outline'}
                className={isRunning
                  ? 'bg-red-500/10 text-red-400 border border-red-500/30 hover:bg-red-500/20'
                  : 'border-green-500/30 text-green-400 hover:bg-green-500/10'}
              >
                {actionLoading ? (
                  <Loader2 size={14} className="mr-1.5 animate-spin" />
                ) : isRunning ? (
                  <><Square size={14} className="mr-1.5" />Stop Agent</>
                ) : (
                  <><Play size={14} className="mr-1.5" />Start Agent</>
                )}
              </Button>
            )}

            {/* Transitioning indicator */}
            {inTransition && (
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <Loader2 size={14} className="animate-spin" />
                {agent.status === 'STARTING' ? 'Starting...' : 'Stopping...'}
              </div>
            )}

            {/* Refresh */}
            <Button variant="ghost" size="sm" onClick={loadAgent} disabled={actionLoading}>
              <RefreshCw size={14} />
            </Button>

            {/* Delete */}
            {!showDeleteConfirm ? (
              <Button variant="ghost" size="sm" onClick={() => setShowDeleteConfirm(true)}
                className="text-muted-foreground hover:text-destructive">
                <Trash2 size={14} />
              </Button>
            ) : (
              <div className="flex items-center gap-2">
                <span className="text-sm text-destructive">Delete agent?</span>
                <Button size="sm" variant="destructive" onClick={handleDelete} disabled={actionLoading}>Yes</Button>
                <Button size="sm" variant="ghost" onClick={() => setShowDeleteConfirm(false)}>No</Button>
              </div>
            )}
          </div>
        </div>
      </div>

      <div className="px-6 py-8 lg:px-8">
        {/* Action error */}
        {actionError && (
          <div className="mb-6 p-4 bg-destructive/10 border border-destructive/30 rounded-lg text-destructive text-sm">
            {actionError}
          </div>
        )}

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">

          {/* ── Left column: info cards ── */}
          <div className="lg:col-span-1 space-y-4">
            {/* Status */}
            <div className="bg-card border border-border rounded-lg p-5">
              <p className="text-xs text-muted-foreground mb-2">Status</p>
              <div className="flex items-center gap-2">
                <Badge className={STATUS_COLOR[agent.status] ?? STATUS_COLOR.STOPPED}>
                  {agent.status}
                </Badge>
                {inTransition && <Loader2 size={12} className="animate-spin text-muted-foreground" />}
              </div>
            </div>

            {/* Configuration */}
            {cfg && (
              <div className="bg-card border border-border rounded-lg p-5">
                <p className="text-xs text-muted-foreground mb-3">Configuration</p>
                <div className="space-y-2">
                  {Object.entries(cfg)
                    .filter(([k]) => !['intent', 'generatedAt', 'warnings', 'riskNotes', 'entryConditions', 'exitConditions'].includes(k))
                    .map(([k, v]) => (
                      <div key={k} className="flex justify-between gap-2 text-sm">
                        <span className="text-muted-foreground capitalize">
                          {k.replace(/([A-Z])/g, ' $1').toLowerCase()}
                        </span>
                        <span className="font-mono text-xs text-right truncate max-w-[120px]" title={String(v)}>
                          {String(v)}
                        </span>
                      </div>
                    ))}
                </div>
              </div>
            )}

            {/* Files */}
            {agent.files.length > 0 && (
              <div className="bg-card border border-border rounded-lg p-5">
                <p className="text-xs text-muted-foreground mb-3">Bot Files ({agent.files.length})</p>
                <div className="space-y-1">
                  {agent.files.map((f) => (
                    <div key={f.id} className="flex items-center gap-2 text-xs font-mono text-muted-foreground">
                      <span className="text-primary/60">📄</span>
                      {f.filepath}
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Recent trades */}
            {agent.tradeLogs.length > 0 && (
              <div className="bg-card border border-border rounded-lg p-5">
                <p className="text-xs text-muted-foreground mb-3">
                  Recent Trades ({agent.tradeLogs.length})
                </p>
                <div className="space-y-2">
                  {agent.tradeLogs.slice(0, 5).map((log) => (
                    <div key={log.id} className="text-xs border border-border rounded p-2">
                      <div className="flex justify-between mb-1">
                        <span className="font-mono text-muted-foreground">
                          {log.tokenIn} → {log.tokenOut}
                        </span>
                        <span className={parseFloat(log.profitUsd) >= 0 ? 'text-green-400' : 'text-red-400'}>
                          {parseFloat(log.profitUsd) >= 0 ? '+' : ''}{log.profitUsd} USD
                        </span>
                      </div>
                      <div className="text-muted-foreground/50 font-mono text-[10px] truncate">
                        {log.txHash}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>

          {/* ── Right column: terminal ── */}
          <div className="lg:col-span-2">
            <div className="bg-card border border-border rounded-lg p-5 mb-6">
              <div className="flex items-center justify-between mb-4">
                <h3 className="text-sm font-semibold">PnL Trend (USD)</h3>
                <Badge className="bg-amber-500/15 text-amber-300 border border-amber-500/30 text-[10px]">
                  Security Checked via GoldRush
                </Badge>
              </div>
              <PnLChart data={pnlData} />
            </div>

            <LiveTerminal agentId={agentId} running={isRunning} />
          </div>

        </div>
      </div>
    </div>
  )
}