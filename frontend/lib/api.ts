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
  await throwIfNotOk(res)
  return res.json()
}

export async function fetchAgent(agentId: string, authHeaders?: HeadersInit): Promise<Agent> {
  const res = await fetch(`/api/agents/${agentId}`, {
    headers: {
      ...(authHeaders ?? {}),
    },
  })
  await throwIfNotOk(res)
  return res.json()
}

export async function deployAgent(payload: DeployAgentPayload, authHeaders?: HeadersInit): Promise<Agent> {
  const res = await fetch('/api/agents', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(authHeaders ?? {}) },
    body: JSON.stringify(payload),
  })
  await throwIfNotOk(res)
  return res.json()
}

export async function deleteAgent(agentId: string, authHeaders?: HeadersInit): Promise<void> {
  const res = await fetch(`/api/agents/${agentId}`, {
    method: 'DELETE',
    headers: {
      ...(authHeaders ?? {}),
    },
  })
  await throwIfNotOk(res)
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
  await throwIfNotOk(res)
  return res.json()
}

export async function fetchAgentLogs(agentId: string, limit = 50, authHeaders?: HeadersInit): Promise<TradeLog[]> {
  const res = await fetch(`/api/agents/${agentId}/logs?limit=${limit}`, {
    headers: { 'Cache-Control': 'no-store', ...(authHeaders ?? {}) },
  })
  await throwIfNotOk(res)
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

// Helper: throw an Error with `status` and `body` when response is not ok
async function throwIfNotOk(res: Response, defaultMsg = 'Request failed'): Promise<void> {
  if (res.ok) return
  let body: unknown = null
  try {
    body = await res.json()
  } catch {
    try {
      body = await res.text()
    } catch {
      body = null
    }
  }
  const message = typeof body === 'string' ? body : (body && (body as any).error) ? (body as any).error : defaultMsg
  const err = new Error(message)
  ;(err as any).status = res.status
  ;(err as any).body = body
  throw err
}