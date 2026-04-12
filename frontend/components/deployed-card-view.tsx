import Link from 'next/link'
import { Button } from '@/components/ui/button'
import { ArrowRight, CheckCircle } from 'lucide-react'

interface Props {
  agentName: string
  agentId:   string
}

export function DeployedCardView({ agentName, agentId }: Props) {
  return (
    <div className="mt-3 bg-green-500/10 border border-green-500/30 rounded-xl p-4 flex items-center gap-3">
      <div className="w-10 h-10 bg-green-500/20 rounded-full flex items-center justify-center flex-shrink-0">
        <CheckCircle size={20} className="text-green-400" />
      </div>
      <div className="flex-1 min-w-0">
        <p className="text-sm font-semibold text-green-300">{agentName} is live</p>
        <p className="text-xs text-green-400/70 truncate">Agent ID: {agentId}</p>
      </div>
      <Link href={`/dashboard/agents/${agentId}`}>
        <Button
          size="sm"
          variant="outline"
          className="border-green-500/30 text-green-300 hover:bg-green-500/10 flex-shrink-0"
        >
          View <ArrowRight size={12} className="ml-1" />
        </Button>
      </Link>
    </div>
  )
}