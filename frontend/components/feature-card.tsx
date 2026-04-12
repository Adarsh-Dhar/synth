import React from 'react'
import { Card } from '@/components/ui/card'

interface FeatureCardProps {
  icon: React.ReactNode
  title: string
  description: string
  gradient?: boolean
}

export function FeatureCard({ icon, title, description, gradient = false }: FeatureCardProps) {
  return (
    <Card
      className={`p-8 border-border/50 backdrop-blur-sm hover:border-primary/50 transition-all duration-300 ${
        gradient ? 'bg-gradient-to-br from-card to-card/50' : 'bg-card/50'
      }`}
    >
      <div className="mb-4 w-12 h-12 rounded-lg bg-gradient-to-br from-primary/20 to-secondary/20 flex items-center justify-center text-2xl">
        {icon}
      </div>
      <h3 className="text-xl font-bold mb-2 text-foreground">{title}</h3>
      <p className="text-foreground/70 leading-relaxed">{description}</p>
    </Card>
  )
}