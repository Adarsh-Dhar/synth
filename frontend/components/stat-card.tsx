import React, { ReactNode } from 'react'
import { TrendingUp, TrendingDown } from 'lucide-react'

interface StatCardProps {
  label: string
  value: string | number
  subvalue?: string
  icon?: ReactNode
  trend?: 'up' | 'down'
  trendPercent?: number
}

export function StatCard({
  label,
  value,
  subvalue,
  icon,
  trend,
  trendPercent,
}: StatCardProps) {
  return (
    <div className="bg-card border border-border rounded-lg p-6">
      <div className="flex items-start justify-between mb-4">
        <div>
          <p className="text-sm text-muted-foreground font-medium">{label}</p>
          <p className="text-3xl font-bold text-foreground mt-1">{value}</p>
          {subvalue && (
            <p className="text-sm text-muted-foreground mt-1">{subvalue}</p>
          )}
        </div>
        {icon && <div className="text-primary">{icon}</div>}
      </div>
      {trend && trendPercent !== undefined && (
        <div className={`flex items-center gap-1 text-sm font-semibold ${
          trend === 'up' ? 'text-green-400' : 'text-red-400'
        }`}>
          {trend === 'up' ? <TrendingUp size={16} /> : <TrendingDown size={16} />}
          {trendPercent}% {trend === 'up' ? 'gain' : 'loss'}
        </div>
      )}
    </div>
  )
}