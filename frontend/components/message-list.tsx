import { Bot, User } from 'lucide-react'
import type { ChatMessage, ConvState, Guardrails } from '../lib/types'
import { PlanCardView }     from './plan-card-view'
import { ConfirmCardView }  from './confirm-card-view'
import { DeployedCardView } from './deployed-card-view'
import { TypingIndicator }  from './typing-indicator'

interface Props {
  messages:           ChatMessage[]
  isTyping:           boolean
  convState:          ConvState
  currentGuardrails:  Guardrails | null
  bottomRef:          React.RefObject<HTMLDivElement | null>
  onApprovePlan:      () => void
  onEditPlan:         () => void
  onConfirmDeploy:    () => void
  onEditGuardrail:    (field: string) => void
}

export function MessageList({
  messages,
  isTyping,
  convState,
  currentGuardrails,
  bottomRef,
  onApprovePlan,
  onEditPlan,
  onConfirmDeploy,
  onEditGuardrail,
}: Props) {
  return (
    <div className="flex-1 overflow-y-auto py-4 space-y-1">
      {messages.map(msg => (
        <div key={msg.id}>
          {msg.role === 'assistant' ? (
            <div className="flex items-end gap-2.5 px-4 py-1 max-w-3xl">
              <div className="w-7 h-7 rounded-full bg-primary/20 border border-primary/30 flex items-center justify-center flex-shrink-0 mb-1">
                <Bot size={13} className="text-primary" />
              </div>
              <div className="flex-1 min-w-0">
                {msg.content && (
                  <div className="bg-card border border-border rounded-2xl rounded-bl-sm px-4 py-3 text-sm text-foreground leading-relaxed whitespace-pre-wrap">
                    {msg.content}
                  </div>
                )}

                {msg.card?.type === 'plan' && (
                  <PlanCardView
                    plan={msg.card.plan}
                    onApprove={onApprovePlan}
                    onEdit={onEditPlan}
                    disabled={convState !== 'reviewing_plan'}
                  />
                )}
                {msg.card?.type === 'confirm' && currentGuardrails && (
                  <ConfirmCardView
                    plan={msg.card.plan}
                    guardrails={currentGuardrails}
                    onConfirm={onConfirmDeploy}
                    onEdit={onEditGuardrail}
                    disabled={convState !== 'guardrails'}
                  />
                )}
                {msg.card?.type === 'deployed' && (
                  <DeployedCardView
                    agentName={msg.card.agentName}
                    agentId={msg.card.agentId}
                  />
                )}
                {msg.card?.type === 'error' && (
                  <div className="mt-2 text-xs text-destructive/70 bg-destructive/10 border border-destructive/20 rounded-lg px-3 py-2">
                    {msg.card.message}
                  </div>
                )}

                <p className="text-[10px] text-muted-foreground/50 mt-1 ml-1">
                  {msg.timestamp.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                </p>
              </div>
            </div>
          ) : (
            <div className="flex items-end justify-end gap-2.5 px-4 py-1">
              <div className="max-w-[75%]">
                <div className="bg-primary text-primary-foreground rounded-2xl rounded-br-sm px-4 py-3 text-sm leading-relaxed whitespace-pre-wrap">
                  {msg.content}
                </div>
                <p className="text-[10px] text-muted-foreground/50 mt-1 mr-1 text-right">
                  {msg.timestamp.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                </p>
              </div>
              <div className="w-7 h-7 rounded-full bg-muted/30 border border-border flex items-center justify-center flex-shrink-0 mb-1">
                <User size={13} className="text-muted-foreground" />
              </div>
            </div>
          )}
        </div>
      ))}

      {isTyping && <TypingIndicator />}
      <div ref={bottomRef} />
    </div>
  )
}