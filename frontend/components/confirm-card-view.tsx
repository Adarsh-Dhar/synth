import { Button } from '@/components/ui/button'
import { AlertTriangle, Clock, DollarSign, Shield, Zap } from 'lucide-react'
import type { AgentPlan, Guardrails } from '../lib/types'
import { strategyLabel } from '../lib/utils'

interface Props {
  plan:       AgentPlan
  guardrails: Guardrails
  onConfirm:  () => void
  onEdit:     (field: string) => void
  disabled:   boolean
}

const GUARDRAIL_ROWS = [
  {
    icon:  DollarSign,
    label: 'Spending limit',
    color: 'text-primary',
    field: 'spendAllowance' as const,
    sub:   'Max total the agent can spend',
    format: (g: Guardrails) => `$${g.spendAllowance.toLocaleString()} USDC`,
  },
  {
    icon:  Clock,
    label: 'Session expires in',
    color: 'text-secondary',
    field: 'sessionDurationHours' as const,
    sub:   'Session key auto-revokes after this',
    format: (g: Guardrails) => `${g.sessionDurationHours} hours`,
  },
  {
    icon:  AlertTriangle,
    label: 'Max daily loss',
    color: 'text-yellow-400',
    field: 'maxDailyLoss' as const,
    sub:   'Agent halts if daily loss hits this',
    format: (g: Guardrails) => `$${g.maxDailyLoss.toLocaleString()} USDC`,
  },
]

export function ConfirmCardView({ plan, guardrails, onConfirm, onEdit, disabled }: Props) {
  return (
    <div className="mt-3 bg-background border border-border rounded-xl overflow-hidden">
      <div className="bg-muted/20 border-b border-border px-4 py-3 flex items-center gap-2">
        <Shield size={14} className="text-primary" />
        <span className="text-sm font-semibold">Hard Guardrails</span>
        <span className="text-xs text-muted-foreground ml-auto">Cannot be overridden by the agent</span>
      </div>

      <div className="p-4 space-y-3">
        {GUARDRAIL_ROWS.map(row => (
          <div
            key={row.field}
            className="flex items-center justify-between bg-muted/10 border border-border rounded-lg px-3 py-2.5"
          >
            <div className="flex items-center gap-2.5">
              <row.icon size={14} className={row.color} />
              <div>
                <p className="text-xs text-muted-foreground">{row.label}</p>
                <p className="text-sm font-semibold">{row.format(guardrails)}</p>
              </div>
            </div>
            <button
              onClick={() => onEdit(row.field)}
              disabled={disabled}
              className="text-xs text-primary hover:underline disabled:opacity-50"
            >
              change
            </button>
          </div>
        ))}

        <div className="bg-primary/5 border border-primary/20 rounded-lg p-3">
          <p className="text-xs text-muted-foreground">
            Deploying <strong className="text-foreground">{plan.agentName}</strong>{' · '}
            {strategyLabel(plan.strategy)} · {plan.targetPair}
          </p>
        </div>

        <Button
          onClick={onConfirm}
          disabled={disabled}
          className="w-full bg-gradient-to-r from-primary to-secondary text-primary-foreground hover:opacity-90 font-semibold py-5"
        >
          <Zap size={16} className="mr-2" />
          Deploy Agent
        </Button>
      </div>
    </div>
  )
}