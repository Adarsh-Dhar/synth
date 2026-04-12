"use client"

import React from 'react'
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
} from 'recharts'

interface ChartDataPoint {
  time: string
  value: number
}

interface PnLChartProps {
  data?: ChartDataPoint[]
}

const DEFAULT_DATA: ChartDataPoint[] = [
  { time: 'Start', value: 0 },
  { time: 'Now', value: 0 },
]

export function PnLChart({ data }: PnLChartProps) {
  const chartData = data && data.length >= 2 ? data : DEFAULT_DATA
  const hasGain = chartData[chartData.length - 1]?.value >= 0

  return (
    <ResponsiveContainer width="100%" height={300}>
      <LineChart data={chartData} margin={{ top: 5, right: 10, left: 10, bottom: 5 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
        <XAxis
          dataKey="time"
          stroke="var(--muted-foreground)"
          style={{ fontSize: '11px' }}
          tick={{ fill: 'var(--muted-foreground)' }}
        />
        <YAxis
          stroke="var(--muted-foreground)"
          style={{ fontSize: '11px' }}
          tick={{ fill: 'var(--muted-foreground)' }}
          tickFormatter={(v) => `$${v}`}
          label={{
            value: 'PnL (USDC)',
            angle: -90,
            position: 'insideLeft',
            fill: 'var(--muted-foreground)',
            fontSize: 11,
          }}
        />
        <Tooltip
          contentStyle={{
            backgroundColor: 'var(--card)',
            border: '1px solid var(--border)',
            borderRadius: '8px',
            color: 'var(--foreground)',
            fontSize: '12px',
          }}
          formatter={(value: number) => [`$${value.toFixed(2)}`, 'PnL']}
          cursor={{ stroke: 'var(--primary)' }}
        />
        <Line
          type="monotone"
          dataKey="value"
          stroke={hasGain ? '#22c55e' : '#ef4444'}
          strokeWidth={2}
          dot={{ fill: hasGain ? '#22c55e' : '#ef4444', r: 3 }}
          activeDot={{ r: 5 }}
        />
      </LineChart>
    </ResponsiveContainer>
  )
}