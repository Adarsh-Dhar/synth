import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  AlertTriangle, ArrowRight, Clock, DollarSign,
  RotateCcw, Shield, Sparkles, TrendingUp,
} from 'lucide-react'
import type { AgentPlan } from '../lib/types'
import { confidenceColor, strategyLabel } from '../lib/utils'

interface Props {
  plan:      AgentPlan
  onApprove: () => void
  onEdit:    () => void
  disabled:  boolean
}

export function PlanCardView({ plan, onApprove, onEdit, disabled }: Props) {
  const stats = [
    {
      icon:  DollarSign,
      label: 'Suggested',
      value: `$${plan.recommendedSpendAllowance.toLocaleString()}`,
      color: 'text-primary',
    },
    {
      icon:  Clock,
      label: 'Duration',
      value: `${plan.sessionDurationHours}h`,
      color: 'text-secondary',
    },
    {
      icon:  Shield,
      label: 'Max loss',
      value: `$${Math.round(plan.recommendedSpendAllowance * 0.1).toLocaleString()}`,
      color: 'text-yellow-400',
    },
  ]

  return (
    <div className="mt-3 bg-background border border-border rounded-xl overflow-hidden">
      {/* Header */}
      <div className="bg-gradient-to-r from-primary/10 to-secondary/10 border-b border-border px-4 py-3 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Sparkles size={14} className="text-primary" />
          <span className="text-sm font-semibold">{plan.agentName}</span>
        </div>
        <Badge className={`text-xs ${confidenceColor(plan.confidence)}`}>
          {plan.confidence} confidence
        </Badge>
      </div>

      <div className="p-4 space-y-3">
        {/* Strategy + Pair */}
        <div className="flex flex-wrap gap-2">
          <span className="text-xs bg-primary/10 text-primary border border-primary/20 px-2.5 py-1 rounded-full">
            {strategyLabel(plan.strategy)}
          </span>
          <span className="text-xs bg-muted/20 text-foreground border border-border px-2.5 py-1 rounded-full font-mono">
            {plan.targetPair}
          </span>
        </div>

        {/* Description */}
        <p className="text-sm text-muted-foreground leading-relaxed">{plan.description}</p>

        {/* Entry / Exit */}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
          <div className="bg-green-500/5 border border-green-500/20 rounded-lg p-3">
            <p className="text-xs font-semibold text-green-400 mb-1.5 flex items-center gap-1">
              <TrendingUp size={11} /> Entry
            </p>
            <ul className="space-y-0.5">
              {plan.entryConditions.map((c, i) => (
                <li key={i} className="text-xs text-foreground/70 flex gap-1.5">
                  <span className="text-green-400 flex-shrink-0">›</span>{c}
                </li>
              ))}
            </ul>
          </div>
          <div className="bg-red-500/5 border border-red-500/20 rounded-lg p-3">
            <p className="text-xs font-semibold text-red-400 mb-1.5 flex items-center gap-1">
              <Shield size={11} /> Exit
            </p>
            <ul className="space-y-0.5">
              {plan.exitConditions.map((c, i) => (
                <li key={i} className="text-xs text-foreground/70 flex gap-1.5">
                  <span className="text-red-400 flex-shrink-0">›</span>{c}
                </li>
              ))}
            </ul>
          </div>
        </div>

        {/* Stats */}
        <div className="grid grid-cols-3 gap-2">
          {stats.map(s => (
            <div key={s.label} className="bg-muted/10 border border-border rounded-lg p-2 text-center">
              <s.icon size={12} className={`${s.color} mx-auto mb-0.5`} />
              <p className="text-[10px] text-muted-foreground">{s.label}</p>
              <p className="text-xs font-semibold">{s.value}</p>
            </div>
          ))}
        </div>

        {/* Warnings */}
        {plan.warnings.length > 0 && (
          <div className="bg-yellow-500/10 border border-yellow-500/30 rounded-lg p-3">
            <p className="text-xs font-semibold text-yellow-400 mb-1 flex items-center gap-1">
              <AlertTriangle size={11} /> Heads up
            </p>
            {plan.warnings.map((w, i) => (
              <p key={i} className="text-xs text-yellow-300/80">{w}</p>
            ))}
          </div>
        )}

        {/* Risk Notes */}
        {plan.riskNotes.length > 0 && (
          <div className="bg-muted/10 border border-muted/20 rounded-lg p-3">
            <p className="text-xs font-semibold text-muted-foreground mb-1">Risk disclosures</p>
            {plan.riskNotes.map((r, i) => (
              <p key={i} className="text-xs text-muted-foreground">• {r}</p>
            ))}
          </div>
        )}

        {/* Actions */}
        <div className="flex gap-2 pt-1">
          <Button
            size="sm"
            variant="outline"
            onClick={onEdit}
            disabled={disabled}
            className="flex-1 border-border text-muted-foreground hover:text-foreground"
          >
            <RotateCcw size={13} className="mr-1.5" /> Revise
          </Button>
          <Button
            size="sm"
            onClick={onApprove}
            disabled={disabled}
            className="flex-1 bg-gradient-to-r from-primary to-secondary text-primary-foreground hover:opacity-90"
          >
            Approve Plan <ArrowRight size={13} className="ml-1.5" />
          </Button>
        </div>
      </div>
    </div>
  )
}