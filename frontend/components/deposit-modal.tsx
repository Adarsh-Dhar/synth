import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { AlertTriangle, Wallet, Zap } from 'lucide-react'

interface Props {
  agentName:    string
  agentAddress: string
  onDeposit:    (amount: string) => Promise<void>
  onSkip:       () => void
  isDepositing: boolean
  error:        string | null
}

export function DepositModal({
  agentName, agentAddress, onDeposit, onSkip, isDepositing, error,
}: Props) {
  const [amount, setAmount] = useState('')
  const valid = amount.trim() !== '' && parseFloat(amount) > 0

  return (
    <div className="fixed inset-0 bg-black/60 backdrop-blur-sm z-50 flex items-center justify-center p-4">
      <div className="bg-card border border-border rounded-2xl p-6 w-full max-w-sm shadow-xl">
        {/* Header */}
        <div className="flex items-center gap-3 mb-5">
          <div className="w-10 h-10 bg-primary/20 rounded-xl flex items-center justify-center">
            <Wallet size={18} className="text-primary" />
          </div>
          <div>
            <h3 className="font-semibold">Fund Your Agent</h3>
            <p className="text-xs text-muted-foreground">Send INIT to {agentName}</p>
          </div>
        </div>

        {/* Agent address */}
        <div className="bg-muted/20 rounded-lg p-3 mb-4">
          <p className="text-xs text-muted-foreground mb-1">Agent wallet</p>
          <p className="font-mono text-xs break-all text-foreground">{agentAddress}</p>
        </div>

        {/* Error */}
        {error && (
          <div className="mb-4 p-3 bg-destructive/10 border border-destructive/30 rounded-lg text-destructive text-xs flex gap-2">
            <AlertTriangle size={13} className="flex-shrink-0 mt-0.5" />
            <span>{error}</span>
          </div>
        )}

        {/* Amount input */}
        <div className="relative mb-4">
          <input
            type="number"
            min="0"
            step="0.1"
            placeholder="Amount to deposit"
            value={amount}
            onChange={e => setAmount(e.target.value)}
            disabled={isDepositing}
            autoFocus
            className="w-full h-12 bg-background border border-border rounded-xl px-4 pr-16 text-foreground placeholder:text-muted-foreground text-sm focus:outline-none focus:border-primary/50 focus:ring-1 focus:ring-primary/20"
          />
          <span className="absolute right-4 top-1/2 -translate-y-1/2 text-sm text-muted-foreground font-medium">
            INIT
          </span>
        </div>

        {/* Actions */}
        <div className="flex flex-col gap-2">
          <Button
            onClick={() => onDeposit(amount)}
            disabled={!valid || isDepositing}
            className="w-full bg-gradient-to-r from-primary to-secondary text-primary-foreground font-semibold py-5 disabled:opacity-50"
          >
            {isDepositing ? (
              <>
                <div className="animate-spin mr-2 w-4 h-4 border-2 border-transparent border-t-primary-foreground rounded-full" />
                Sending…
              </>
            ) : (
              <>
                <Zap size={15} className="mr-2" />
                Send {amount || '0'} INIT
              </>
            )}
          </Button>
          <Button
            variant="ghost"
            onClick={onSkip}
            disabled={isDepositing}
            className="text-muted-foreground text-sm"
          >
            Skip — fund later
          </Button>
        </div>
      </div>
    </div>
  )
}