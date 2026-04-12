"use client"

import React, { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { ArrowRight, Zap, Shield, ExternalLink } from 'lucide-react'
import { useWallet } from '@solana/wallet-adapter-react'

type BridgeNotice = {
  kind: 'success' | 'error'
  message: string
}

const BRIDGE_NETWORKS = [
  { id: 'devnet', name: 'Solana Devnet', icon: '◎' },
]

type EnvValues = Record<string, string>

type SpreadSnapshot = {
  poolA: number | null
  poolB: number | null
  spreadAbs: number | null
  spreadPct: number | null
}

type SpreadImpact = {
  before: SpreadSnapshot
  after: SpreadSnapshot
  deltaAbs: number | null
  deltaPct: number | null
}

function toFiniteNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string') {
    const trimmed = value.trim()
    if (!trimmed) return null
    const parsed = Number(trimmed)
    if (Number.isFinite(parsed)) return parsed
  }
  return null
}

function extractQuoteValue(payload: unknown): number | null {
  if (payload && typeof payload === 'object') {
    const root = payload as Record<string, unknown>
    const direct = toFiniteNumber(root.balance ?? root.amount ?? root.value ?? root.coin_amount)
    if (direct !== null) return direct

    const result = root.result
    if (result && typeof result === 'object') {
      const nested = result as Record<string, unknown>
      const nestedDirect = toFiniteNumber(nested.balance ?? nested.amount ?? nested.value ?? nested.coin_amount)
      if (nestedDirect !== null) return nestedDirect

      const content = nested.content
      if (Array.isArray(content)) {
        for (const item of content) {
          if (!item || typeof item !== 'object') continue
          const text = (item as Record<string, unknown>).text
          if (typeof text !== 'string') continue
          const digits = text.replace(/[^0-9.]/g, '')
          const parsed = toFiniteNumber(digits)
          if (parsed !== null) return parsed
        }
      }
    }
  }

  if (typeof payload === 'string') {
    const match = payload.match(/[0-9]+(?:\.[0-9]+)?/)
    if (!match) return null
    return toFiniteNumber(match[0])
  }

  return null
}

function buildPriceViewArgs(template: string, endpointAddress: string): string[] {
  return template
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => (part === '$endpoint' ? endpointAddress : part))
}

function normalizeSolanaObjectAddress(value: string): string {
  const trimmed = String(value || '').trim()
  if (!trimmed) return ''
  if (trimmed.startsWith('init1')) return trimmed

  let hex = trimmed
  if (trimmed.startsWith('move/')) {
    hex = trimmed.slice(5)
  }

  hex = hex.replace(/^0x/i, '').toLowerCase()

  if (!hex) return ''
  if (hex.length < 64) {
    hex = hex.padStart(64, '0')
  }

  return `0x${hex}`
}

function normalizeSolanaModuleAddress(value: string): string {
  const trimmed = String(value || '').trim()
  if (!trimmed) return ''
  if (trimmed.startsWith('move/')) {
    return `0x${trimmed.slice(5).replace(/^0x/i, '').toLowerCase()}`
  }
  if (trimmed.startsWith('0x') || trimmed.startsWith('init1')) {
    return trimmed
  }
  return `0x${trimmed.replace(/^0x/i, '').toLowerCase()}`
}

function computeSnapshot(poolA: number | null, poolB: number | null): SpreadSnapshot {
  if (poolA === null || poolB === null) {
    return { poolA, poolB, spreadAbs: null, spreadPct: null }
  }

  const spreadAbs = Math.abs(poolA - poolB)
  const base = Math.min(poolA, poolB)
  const spreadPct = base > 0 ? (spreadAbs / base) * 100 : null
  return { poolA, poolB, spreadAbs, spreadPct }
}

function fmt(value: number | null, digits = 2): string {
  if (value === null || !Number.isFinite(value)) return 'n/a'
  return value.toLocaleString(undefined, {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  })
}

function extractMcpErrorText(payload: unknown): string {
  if (!payload || typeof payload !== 'object') return ''

  const root = payload as Record<string, unknown>
  const result = root.result
  if (!result || typeof result !== 'object') return ''

  const content = (result as Record<string, unknown>).content
  if (!Array.isArray(content)) return ''

  for (const item of content) {
    if (!item || typeof item !== 'object') continue
    const text = (item as Record<string, unknown>).text
    if (typeof text === 'string' && text.trim()) return text
  }

  return ''
}

export default function BridgePage() {
  const { publicKey, connect } = useWallet()
  const connected = !!publicKey
  const walletAddress = publicKey ? publicKey.toBase58() : ''

  const [fromNetwork, setFromNetwork] = useState('devnet')
  const [amount,      setAmount]      = useState('')
  const [isBridging,  setIsBridging]  = useState(false)
  const [bridgeNotice, setBridgeNotice] = useState<BridgeNotice | null>(null)
  const [fatPool, setFatPool] = useState('A')
  const [fatAmount, setFatAmount] = useState('50000')
  const [fatDirection, setFatDirection] = useState<'buy' | 'sell'>('buy')
  const [isFatSwapping, setIsFatSwapping] = useState(false)
  const [fatResult, setFatResult] = useState<string | null>(null)
  const [spreadImpact, setSpreadImpact] = useState<SpreadImpact | null>(null)

  const bridgeFee    = 0.5
  const receiveAmt   = amount && parseFloat(amount) > 0
    ? Math.max(0, parseFloat(amount) - bridgeFee).toFixed(2)
    : '0.00'
  const isFormValid  = !!(fromNetwork && amount && parseFloat(amount) > 0)

  const handleBridge = async () => {
    setIsBridging(true)
    setBridgeNotice(null)

    try {
      if (!connected) {
        await connect?.()
        setBridgeNotice({ kind: 'error', message: 'Connect your wallet first.' })
        return
      }

      // Deposit/bridge UI was Solana-specific and isn't implemented for Solana here.
      // For now, instruct the user to deposit SOL to their connected wallet address.
      setBridgeNotice({ kind: 'success', message: 'Wallet connected. Deposit SOL to your wallet address to proceed.' })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      setBridgeNotice({
        kind: 'error',
        message: `Unable to open bridge modal: ${message}`,
      })
    } finally {
      setIsBridging(false)
    }
  }

  const callMcpTool = async (
    tool: 'move_view' | 'move_execute',
    body: Record<string, unknown>,
    mcpGatewayUrl: string,
  ): Promise<unknown> => {
    const res = await fetch(`/api/mcp-proxy/solana/${tool}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-mcp-upstream-url': mcpGatewayUrl,
      },
      body: JSON.stringify(body),
    })

    const data = await res.json().catch(() => ({}))
    if (!res.ok) {
      const rich = extractMcpErrorText(data)
      throw new Error(rich || JSON.stringify(data).slice(0, 1200))
    }

    const embeddedError = extractMcpErrorText(data)
    if (embeddedError) {
      throw new Error(embeddedError)
    }

    return data
  }

  const sampleSpread = async (values: EnvValues): Promise<SpreadSnapshot | null> => {
    const mcpGateway = values['MCP_GATEWAY_URL'] || 'http://localhost:8000/mcp'
    const network = values['SOLANA_NETWORK'] || 'solana-testnet'
    const poolAAddress = normalizeSolanaObjectAddress(values['SOLANA_POOL_A_ADDRESS'] || '')
    const poolBAddress = normalizeSolanaObjectAddress(values['SOLANA_POOL_B_ADDRESS'] || '')
    const viewAddress = normalizeSolanaModuleAddress(values['SOLANA_PRICE_VIEW_ADDRESS'] || '')
    const viewModule = values['SOLANA_PRICE_VIEW_MODULE'] || ''
    const viewFunction = values['SOLANA_PRICE_VIEW_FUNCTION'] || ''
    const typeArgsRaw = values['SOLANA_PRICE_VIEW_TYPE_ARGS'] || '0x1::coin::uinit,0x1::coin::uusdc'
    const viewArgsTemplate = values['SOLANA_PRICE_VIEW_ARGS'] || '$endpoint,$amount'

    if (!poolAAddress || !poolBAddress || !viewAddress || !viewModule || !viewFunction) {
      return null
    }

    const typeArgs = typeArgsRaw.split(',').map((part) => part.trim()).filter(Boolean)

    const [poolAResult, poolBResult] = await Promise.allSettled([
      callMcpTool('move_view', {
        network,
        address: viewAddress,
        module: viewModule,
        function: viewFunction,
        type_args: typeArgs,
        args: buildPriceViewArgs(viewArgsTemplate, poolAAddress),
      }, mcpGateway),
      callMcpTool('move_view', {
        network,
        address: viewAddress,
        module: viewModule,
        function: viewFunction,
        type_args: typeArgs,
        args: buildPriceViewArgs(viewArgsTemplate, poolBAddress),
      }, mcpGateway),
    ])

    const poolAQuote = poolAResult.status === 'fulfilled' ? extractQuoteValue(poolAResult.value) : null
    const poolBQuote = poolBResult.status === 'fulfilled' ? extractQuoteValue(poolBResult.value) : null
    return computeSnapshot(poolAQuote, poolBQuote)
  }

  const handleFatFinger = async () => {
    setIsFatSwapping(true)
    setFatResult(null)
    setSpreadImpact(null)

    try {
      const envRes = await fetch('/api/env-defaults')
      const envData = await envRes.json().catch(() => ({}))
      const values = (envData?.values ?? {}) as EnvValues

      const poolAAddress = normalizeSolanaObjectAddress(values['SOLANA_POOL_A_ADDRESS'] || '')
      const poolBAddress = normalizeSolanaObjectAddress(values['SOLANA_POOL_B_ADDRESS'] || '')
      const poolAddress = fatPool === 'A' ? poolAAddress : poolBAddress
      const mcpGateway = values['MCP_GATEWAY_URL'] || 'http://localhost:8000/mcp'
      const network = values['SOLANA_NETWORK'] || 'solana-testnet'

      if (!poolAAddress || !poolBAddress) {
        setFatResult('Error: Set SOLANA_POOL_A_ADDRESS and SOLANA_POOL_B_ADDRESS in agents/.env first.')
        return
      }

      if (!poolAddress) {
        setFatResult('Error: Pool address is empty.')
        return
      }

      const amountValue = Number(fatAmount)
      if (!Number.isFinite(amountValue) || amountValue <= 0) {
        setFatResult('Error: Enter a valid swap amount greater than 0.')
        return
      }

      const amountMicro = String(Math.floor(amountValue * 1_000_000))
      const typeArgsRaw = values['SOLANA_PRICE_VIEW_TYPE_ARGS'] || '0x1::coin::uinit,0x1::coin::uusdc'
      const baseTypeArgs = typeArgsRaw.split(',').map((part) => part.trim()).filter(Boolean)
      const usdcMetadataAddress = normalizeSolanaObjectAddress(values['SOLANA_USDC_METADATA_ADDRESS'] || '')
      const initMetadataAddress = normalizeSolanaObjectAddress(values['SOLANA_INIT_METADATA_ADDRESS'] || '')

      if (baseTypeArgs.length < 2) {
        setFatResult('Error: SOLANA_PRICE_VIEW_TYPE_ARGS must contain two comma-separated coin types.')
        return
      }

      if (!usdcMetadataAddress || !initMetadataAddress) {
        setFatResult('Error: Set SOLANA_USDC_METADATA_ADDRESS and SOLANA_INIT_METADATA_ADDRESS in agents/.env first.')
        return
      }

      const spreadBefore = await sampleSpread(values)

      const offerMetadata = fatDirection === 'buy' ? usdcMetadataAddress : initMetadataAddress
      const returnMetadata = fatDirection === 'buy' ? initMetadataAddress : usdcMetadataAddress

      await callMcpTool('move_execute', {
        network,
        address: '0x1',
        module: 'dex',
        function: 'swap_script',
        type_args: [],
        args: [
          poolAddress,
          offerMetadata,
          returnMetadata,
          amountMicro,
        ],
      }, mcpGateway)

      const spreadAfter = await sampleSpread(values)
      if (spreadBefore && spreadAfter) {
        setSpreadImpact({
          before: spreadBefore,
          after: spreadAfter,
          deltaAbs:
            spreadBefore.spreadAbs !== null && spreadAfter.spreadAbs !== null
              ? spreadAfter.spreadAbs - spreadBefore.spreadAbs
              : null,
          deltaPct:
            spreadBefore.spreadPct !== null && spreadAfter.spreadPct !== null
              ? spreadAfter.spreadPct - spreadBefore.spreadPct
              : null,
        })
      }

      setFatResult(
        `Done! Swapped ${fatAmount} ${fatDirection === 'buy' ? 'USDC→token' : 'token→USDC'} on Pool ${fatPool}. Your bot should fire within the next poll cycle.`,
      )
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      if (/invalid address/i.test(message)) {
        setFatResult(
          'Error: One of the pool or metadata addresses is not a valid Solana object address. Use 0x... or move/... values from Solana Explorer.',
        )
        return
      }
      if (/TYPE_RESOLUTION_FAILURE/i.test(message)) {
        setFatResult(
          'Error: TYPE_RESOLUTION_FAILURE. SOLANA_USDC_METADATA_ADDRESS and SOLANA_INIT_METADATA_ADDRESS must be valid Object<Metadata> addresses for this network.',
        )
      } else if (/FAILED_TO_DESERIALIZE_ARGUMENT/i.test(message) && /object does not hold the type/i.test(message)) {
        setFatResult(
          'Error: Pool address is not the expected LP metadata object for this swap module. Verify SOLANA_POOL_A_ADDRESS / SOLANA_POOL_B_ADDRESS are the correct pool object addresses for this network.',
        )
      } else {
        setFatResult(`Error: ${message}`)
      }
    } finally {
      setIsFatSwapping(false)
    }
  }

  return (
    <div className="min-h-screen bg-background">
      <div className="sticky top-0 z-30 bg-background border-b border-border">
        <div className="px-6 py-4 lg:px-8">
          <h1 className="text-3xl font-bold">Cross-Chain Bridge</h1>
          <p className="text-muted-foreground mt-1">Deposit funds from other chains to Synth on Solana</p>
        </div>
      </div>

      <div className="px-6 py-8 lg:px-8">
        <div className="max-w-2xl mx-auto">
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
            {/* Bridge form */}
            <div className="lg:col-span-2 bg-card border border-border rounded-lg p-8">
              {!connected && (
                <div className="mb-6 p-4 bg-yellow-500/10 border border-yellow-500/30 rounded-lg text-yellow-300 text-sm">
                  Connect your wallet to use the bridge.
                </div>
              )}

              {bridgeNotice && (
                <div className={`mb-6 p-4 rounded-lg text-sm font-medium border ${
                  bridgeNotice.kind === 'success'
                    ? 'bg-green-500/10 border-green-500/30 text-green-400'
                    : 'bg-destructive/10 border-destructive/30 text-destructive'
                }`}>
                  {bridgeNotice.kind === 'success' ? '✓ ' : ''}
                  {bridgeNotice.message}
                </div>
              )}

              <div className="space-y-6">
                <div>
                  <Label htmlFor="from-network" className="mb-2 block font-semibold">From Network</Label>
                  <Select value={fromNetwork} onValueChange={setFromNetwork}>
                    <SelectTrigger id="from-network" className="bg-background border-border h-12">
                      <SelectValue placeholder="Select source network…" />
                    </SelectTrigger>
                    <SelectContent>
                      {BRIDGE_NETWORKS.map(n => (
                        <SelectItem key={n.id} value={n.id}>
                          {n.icon} {n.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                <div>
                  <Label htmlFor="amount" className="mb-2 block font-semibold">Amount to Bridge</Label>
                  <div className="relative">
                    <Input
                      id="amount" type="number" min="0" placeholder="Enter amount"
                      value={amount} onChange={e => setAmount(e.target.value)}
                      className="bg-background border-border text-foreground pr-16 h-12"
                    />
                    <span className="absolute right-4 top-1/2 -translate-y-1/2 font-semibold text-muted-foreground">USDC</span>
                  </div>
                </div>

                <div className="flex justify-center py-2">
                  <div className="bg-primary/10 border border-primary/20 rounded-full p-3">
                    <ArrowRight size={24} className="text-primary" />
                  </div>
                </div>

                <div>
                  <Label className="mb-2 block font-semibold">To Network</Label>
                    <div className="bg-background border border-border rounded-lg p-4 flex items-center gap-3">
                      <span className="text-2xl">⚡</span>
                      <div>
                        <p className="font-semibold">Synth · Solana</p>
                        <p className="text-sm text-muted-foreground">Fast block times</p>
                      </div>
                    </div>
                </div>

                {/* Connected wallet display */}
                {connected && walletAddress && (
                  <div className="bg-primary/5 border border-primary/20 rounded-lg p-3 flex items-center gap-2 text-sm">
                    <div className="w-2 h-2 rounded-full bg-green-400" />
                    <span className="text-muted-foreground">Depositing to:</span>
                    <span className="font-mono text-foreground truncate">
                      {walletAddress.slice(0, 12)}…{walletAddress.slice(-6)}
                    </span>
                  </div>
                )}

                <Button
                  onClick={handleBridge}
                  disabled={!isFormValid || isBridging}
                  className="w-full bg-gradient-to-r from-primary to-secondary hover:opacity-90 text-primary-foreground font-semibold py-6 text-base disabled:opacity-50"
                >
                  {isBridging ? (
                    <><div className="animate-spin mr-2 w-4 h-4 border-2 border-transparent border-t-primary-foreground rounded-full" />Bridging…</>
                  ) : (
                    <><Zap size={20} className="mr-2" />Open Bridge Modal</>
                  )}
                </Button>

                {amount && parseFloat(amount) > 0 && (
                  <div className="bg-muted/10 border border-muted/30 rounded-lg p-4 text-sm">
                    <p className="text-muted-foreground mb-2">Estimated Breakdown</p>
                    <div className="space-y-1">
                      <div className="flex justify-between"><span>Amount</span><span>{amount} USDC</span></div>
                      <div className="flex justify-between text-muted-foreground"><span>Bridge Fee</span><span>~$0.50</span></div>
                      <div className="border-t border-muted mt-2 pt-2 flex justify-between font-medium">
                        <span>You receive</span><span>~{receiveAmt} USDC</span>
                      </div>
                    </div>
                  </div>
                )}
              </div>
            </div>

            {/* Sidebar */}
            <div className="space-y-6">
              <div className="bg-card border border-border rounded-lg p-6">
                <div className="flex items-start gap-3 mb-3">
                  <Shield size={20} className="text-primary flex-shrink-0 mt-0.5" />
                  <div>
                    <h3 className="font-semibold">Secure Bridge</h3>
                    <p className="text-xs text-muted-foreground mt-1">
                      Multi-signature validation via the Interwoven Bridge protocol.
                    </p>
                  </div>
                </div>
                <a
                  href="https://app.solana.xyz/bridge"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex items-center gap-1.5 text-xs text-primary hover:underline mt-3"
                >
                  Open Bridge App <ExternalLink size={11} />
                </a>
              </div>

              <div className="bg-card border border-border rounded-lg p-6">
                <h3 className="font-semibold mb-4">Supported Assets</h3>
                {[
                  { name: 'USDC', status: 'Active', active: true },
                  { name: 'USDT', status: 'Coming Soon', active: false },
                  { name: 'ETH',  status: 'Coming Soon', active: false },
                ].map(a => (
                  <div key={a.name} className="flex items-center justify-between py-1">
                    <span className="text-sm">{a.name}</span>
                    <span className={`text-xs px-2 py-0.5 rounded ${a.active ? 'bg-primary/10 text-primary' : 'bg-muted/20 text-muted-foreground'}`}>
                      {a.status}
                    </span>
                  </div>
                ))}
              </div>

              <div className="bg-card border border-border rounded-lg p-6">
                <h3 className="font-semibold mb-2 flex items-center gap-2">
                  <Zap size={16} className="text-primary" /> Fast Transactions
                </h3>
                <p className="text-sm text-muted-foreground">
                  Fast block times mean deposits arrive almost instantly after bridge confirmation.
                </p>
              </div>
            </div>

            {/* Fat Finger Trade Panel */}
            <div className="lg:col-span-3 bg-card border border-border rounded-lg p-6 mt-2">
              <div className="flex items-center gap-2 mb-4">
                <Zap size={18} className="text-yellow-400" />
                <h3 className="font-semibold text-foreground">Fat Finger Trade (Testnet)</h3>
                <span className="text-xs px-2 py-0.5 rounded bg-yellow-500/10 border border-yellow-500/30 text-yellow-400">
                  Imbalances a pool to trigger your spread scanner bot
                </span>
              </div>

              <p className="text-sm text-muted-foreground mb-4">
                Executes a massive one-sided swap on the selected pool to create an artificial price spread.
                Your running spread scanner bot will detect it and fire.
              </p>

              <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 mb-4">
                <div>
                  <Label className="mb-2 block text-xs">Pool to imbalance</Label>
                  <Select value={fatPool} onValueChange={setFatPool}>
                    <SelectTrigger className="bg-background border-border h-10">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="A">Pool A</SelectItem>
                      <SelectItem value="B">Pool B</SelectItem>
                    </SelectContent>
                  </Select>
                </div>

                <div>
                  <Label className="mb-2 block text-xs">Direction</Label>
                  <Select value={fatDirection} onValueChange={(v) => setFatDirection(v as 'buy' | 'sell')}>
                    <SelectTrigger className="bg-background border-border h-10">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="buy">Buy token with USDC (raises token price)</SelectItem>
                      <SelectItem value="sell">Sell token for USDC (lowers token price)</SelectItem>
                    </SelectContent>
                  </Select>
                </div>

                <div>
                  <Label className="mb-2 block text-xs">Swap amount (USDC)</Label>
                  <Input
                    type="number"
                    value={fatAmount}
                    onChange={(e) => setFatAmount(e.target.value)}
                    className="bg-background border-border h-10"
                    placeholder="50000"
                  />
                </div>
              </div>

              <Button
                onClick={handleFatFinger}
                disabled={isFatSwapping || !connected}
                className="bg-yellow-500/10 border border-yellow-500/30 text-yellow-300 hover:bg-yellow-500/20 w-full sm:w-auto"
                variant="outline"
              >
                {isFatSwapping ? (
                  <><div className="animate-spin mr-2 w-4 h-4 border-2 border-transparent border-t-yellow-400 rounded-full" />Executing swap...</>
                ) : (
                  <><Zap size={16} className="mr-2" />Execute Fat Finger Swap</>
                )}
              </Button>

              {spreadImpact && (
                <div className="mt-4 p-4 rounded-lg text-sm border bg-primary/5 border-primary/20">
                  <p className="text-muted-foreground mb-2">Spread Impact</p>
                  <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                    <div className="rounded-md bg-background/70 border border-border p-3">
                      <p className="text-xs text-muted-foreground mb-1">Before</p>
                      <p className="font-medium">A: {fmt(spreadImpact.before.poolA, 0)}</p>
                      <p className="font-medium">B: {fmt(spreadImpact.before.poolB, 0)}</p>
                      <p className="text-xs text-muted-foreground mt-1">
                        Spread: {fmt(spreadImpact.before.spreadAbs, 0)} ({fmt(spreadImpact.before.spreadPct)}%)
                      </p>
                    </div>
                    <div className="rounded-md bg-background/70 border border-border p-3">
                      <p className="text-xs text-muted-foreground mb-1">After</p>
                      <p className="font-medium">A: {fmt(spreadImpact.after.poolA, 0)}</p>
                      <p className="font-medium">B: {fmt(spreadImpact.after.poolB, 0)}</p>
                      <p className="text-xs text-muted-foreground mt-1">
                        Spread: {fmt(spreadImpact.after.spreadAbs, 0)} ({fmt(spreadImpact.after.spreadPct)}%)
                      </p>
                    </div>
                    <div className="rounded-md bg-background/70 border border-border p-3">
                      <p className="text-xs text-muted-foreground mb-1">Delta</p>
                      <p className="font-medium">Abs: {fmt(spreadImpact.deltaAbs, 0)}</p>
                      <p className="font-medium">Pct: {fmt(spreadImpact.deltaPct)}%</p>
                    </div>
                  </div>
                </div>
              )}

              {fatResult && (
                <div className={`mt-4 p-3 rounded-lg text-sm border ${
                  fatResult.startsWith('Error')
                    ? 'bg-destructive/10 border-destructive/30 text-destructive'
                    : 'bg-green-500/10 border-green-500/30 text-green-400'
                }`}>
                  {fatResult}
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}