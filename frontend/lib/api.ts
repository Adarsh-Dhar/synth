// ─── Types ────────────────────────────────────────────────────────────────────

export interface Agent {
  id: string
  name: string
  strategy: 'MEME_SNIPER' | 'ARBITRAGE' | 'SENTIMENT_TRADER'
  status: 'RUNNING' | 'PAUSED' | 'REVOKED' | 'EXPIRED' | 'STARTING' | 'STOPPING' | 'STOPPED' | 'ERROR'
  targetPair: string
  spendAllowance: number
  sessionExpiresAt: string
  sessionKeyPub: string | null
  currentPnl: number
  userId: string
  createdAt: string
  updatedAt: string
  logs?: TradeLog[]
  configuration?: Record<string, unknown>
}

export interface TradeLog {
  id: string
  type: 'INFO' | 'EXECUTION_BUY' | 'EXECUTION_SELL' | 'PROFIT_SECURED' | 'ERROR'
  message: string
  txHash: string | null
  price: number | null
  amount: number | null
  agentId: string
  timestamp: string
}

export interface DeployAgentPayload {
  userId: string
  name: string
  strategy: string
  targetPair: string
  spendAllowance: number
  sessionExpiresAt: string
  sessionKeyPub?: string
}

// ─── Agent API ────────────────────────────────────────────────────────────────

export async function fetchAgents(authHeaders?: HeadersInit): Promise<Agent[]> {
  const res = await fetch('/api/agents', {
    headers: {
      ...(authHeaders ?? {}),
    },
  })
  if (!res.ok) throw new Error('Failed to fetch agents')
  return res.json()
}

export async function fetchAgent(agentId: string, authHeaders?: HeadersInit): Promise<Agent> {
  const res = await fetch(`/api/agents/${agentId}`, {
    headers: {
      ...(authHeaders ?? {}),
    },
  })
  if (!res.ok) throw new Error('Failed to fetch agent')
  return res.json()
}

export async function deployAgent(payload: DeployAgentPayload, authHeaders?: HeadersInit): Promise<Agent> {
  const res = await fetch('/api/agents', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(authHeaders ?? {}) },
    body: JSON.stringify(payload),
  })
  if (!res.ok) {
    const err = await res.json().catch(() => ({}))
    throw new Error((err as { error?: string }).error ?? 'Failed to deploy agent')
  }
  return res.json()
}

export async function deleteAgent(agentId: string, authHeaders?: HeadersInit): Promise<void> {
  const res = await fetch(`/api/agents/${agentId}`, {
    method: 'DELETE',
    headers: {
      ...(authHeaders ?? {}),
    },
  })
  if (!res.ok) throw new Error('Failed to delete agent')
}

export async function updateAgentStatus(
  agentId: string,
  status: 'RUNNING' | 'PAUSED' | 'REVOKED' | 'EXPIRED',
  authHeaders?: HeadersInit,
): Promise<Agent> {
  const res = await fetch(`/api/agents/${agentId}/status`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', ...(authHeaders ?? {}) },
    body: JSON.stringify({ status }),
  })
  if (!res.ok) throw new Error('Failed to update agent status')
  return res.json()
}

export async function fetchAgentLogs(agentId: string, limit = 50, authHeaders?: HeadersInit): Promise<TradeLog[]> {
  const res = await fetch(`/api/agents/${agentId}/logs?limit=${limit}`, {
    headers: { 'Cache-Control': 'no-store', ...(authHeaders ?? {}) },
  })
  if (!res.ok) throw new Error('Failed to fetch logs')
  return res.json()
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

export function formatSessionExpiry(expiresAt: string): string {
  const diff = new Date(expiresAt).getTime() - Date.now()
  if (diff <= 0) return 'Expired'
  const h = Math.floor(diff / 3_600_000)
  const m = Math.floor((diff % 3_600_000) / 60_000)
  return `${h}h ${m}m`
}

export function strategyLabel(strategy: Agent['strategy']): string {
  return {
    MEME_SNIPER: 'Meme Sniper',
    ARBITRAGE: 'Arbitrage',
    SENTIMENT_TRADER: 'Sentiment Trader',
  }[strategy]
}