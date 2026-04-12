"use client"

import React, { useEffect, useRef } from 'react'
import { TradeLog } from '@/lib/api'

interface ExecutionTerminalProps {
  logs: TradeLog[]
}

const TYPE_COLOR: Record<TradeLog['type'], string> = {
  INFO:            'text-muted-foreground',
  EXECUTION_BUY:   'text-blue-400',
  EXECUTION_SELL:  'text-purple-400',
  PROFIT_SECURED:  'text-green-400',
  ERROR:           'text-red-400',
}

const TYPE_PREFIX: Record<TradeLog['type'], string> = {
  INFO:            '[INFO ] ',
  EXECUTION_BUY:   '[BUY  ] ',
  EXECUTION_SELL:  '[SELL ] ',
  PROFIT_SECURED:  '[WIN  ] ',
  ERROR:           '[ERROR] ',
}

function fmtTime(ts: string): string {
  const d = new Date(ts)
  return [d.getHours(), d.getMinutes(), d.getSeconds()]
    .map((n) => String(n).padStart(2, '0'))
    .join(':')
}

export function ExecutionTerminal({ logs }: ExecutionTerminalProps) {
  const endRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [logs])

  return (
    <div className="bg-card border border-border rounded-lg overflow-hidden flex flex-col h-[520px]">
      {/* Header */}
      <div className="bg-muted/30 border-b border-border px-4 py-3 flex items-center justify-between">
        <h3 className="font-semibold text-foreground text-sm tracking-wide">
          Live Execution Terminal
        </h3>
        <div className="flex items-center gap-2">
          <span className="text-xs text-muted-foreground">{logs.length} events</span>
          <span className="w-2 h-2 rounded-full bg-green-400 animate-pulse" />
        </div>
      </div>

      {/* Body */}
      <div className="flex-1 overflow-y-auto bg-[#0a0d14] p-4 font-mono text-xs space-y-1.5">
        {logs.length === 0 ? (
          <div className="text-muted-foreground/60">
            <span className="text-green-400">$</span> Waiting for agent activity…
          </div>
        ) : (
          logs.map((log) => {
            const color  = TYPE_COLOR[log.type]
            const prefix = TYPE_PREFIX[log.type]
            return (
              <div key={log.id} className="flex gap-2 leading-relaxed group">
                {/* Timestamp */}
                <span className="flex-shrink-0 text-muted-foreground/40 select-none">
                  {fmtTime(log.timestamp)}
                </span>

                {/* Type prefix */}
                <span className={`flex-shrink-0 ${color} select-none`}>
                  {prefix}
                </span>

                {/* Message + optional tx hash */}
                <span className={`flex-1 break-all ${color}`}>
                  {log.message}
                  {log.txHash && (
                    <span className="text-muted-foreground/50 ml-1">
                      · TX {log.txHash.slice(0, 10)}…
                    </span>
                  )}
                  {log.price != null && log.amount != null && (
                    <span className="text-muted-foreground/50 ml-1">
                      · {log.amount} @ ${log.price.toFixed(4)}
                    </span>
                  )}
                </span>
              </div>
            )
          })
        )}
        <div ref={endRef} />
      </div>

      {/* Footer */}
      <div className="bg-muted/30 border-t border-border px-4 py-2 text-xs text-muted-foreground flex items-center gap-2">
        <span className="w-1.5 h-1.5 rounded-full bg-green-400 animate-pulse" />
        Polling every 15s · {logs.length} events loaded
      </div>
    </div>
  )
}