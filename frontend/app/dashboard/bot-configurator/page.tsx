'use client'

/**
 * frontend/app/dashboard/bot-configurator/page.tsx
 *
 * Universal Meta-Agent chat page.
 */

import React, { useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { Bot, Send, Zap, Terminal, ArrowRight, Check } from 'lucide-react'
import { useBotConfigChat } from '@/hooks/use-bot-config-chat'

function TypingIndicator() {
  return (
    <div className="flex items-end gap-2.5 px-4 py-2">
      <div className="w-7 h-7 rounded-full bg-primary/15 border border-primary/30 flex items-center justify-center flex-shrink-0">
        <Bot size={13} className="text-primary" />
      </div>
      <div className="bg-card border border-border rounded-2xl rounded-bl-sm px-4 py-3 shadow-sm">
        <div className="flex gap-1 items-center h-4">
          <span className="w-1.5 h-1.5 rounded-full bg-primary/70 animate-bounce [animation-delay:0ms]" />
          <span className="w-1.5 h-1.5 rounded-full bg-secondary/80 animate-bounce [animation-delay:150ms]" />
          <span className="w-1.5 h-1.5 rounded-full bg-primary/60 animate-bounce [animation-delay:300ms]" />
        </div>
      </div>
    </div>
  )
}

function DynamicCredentialsCard({ fields, onSubmit, disabled, defaultValues }: { fields: any[], onSubmit: (d: any) => void, disabled: boolean, defaultValues: Record<string, string> }) {
  const [data, setData] = useState<Record<string, string>>({});
  React.useEffect(() => {
    const seeded: Record<string, string> = {};
    for (const f of fields) {
      seeded[f.key] = defaultValues[f.key] ?? "";
    }
    setData(seeded);
  }, [fields, defaultValues]);

  const hasMissingRequired = fields.some((f) => !(data[f.key] ?? '').trim());
  return (
    <div className="mt-3 bg-card border border-border rounded-xl p-4 w-full max-w-md shadow-sm">
      <div className="space-y-4">
        {fields.map(f => (
          <div key={f.key}>
            <label className="block text-xs font-medium text-foreground/80 mb-1">{f.label}</label>
            <input
              type={f.type === 'password' ? 'password' : 'text'}
              placeholder={f.placeholder}
              value={data[f.key] || ''}
              onChange={e => setData({...data, [f.key]: e.target.value})}
              disabled={disabled}
              className="w-full bg-background border border-border rounded-lg px-3 py-2 text-sm text-foreground outline-none focus:border-primary/60 focus:ring-2 focus:ring-primary/20"
            />
          </div>
        ))}
        <button
          onClick={() => onSubmit(data)}
          disabled={disabled || hasMissingRequired}
          className="w-full bg-primary hover:bg-primary/90 disabled:bg-muted disabled:text-muted-foreground text-primary-foreground text-sm font-medium py-2 rounded-lg transition-colors"
        >
          Generate Bot
        </button>
      </div>
    </div>
  );
}

function SuccessCard({ agentId, botName }: { agentId: string; botName: string }) {
  const router = useRouter()
  return (
    <div className="mt-3 bg-gradient-to-r from-secondary/15 to-background border border-secondary/30 rounded-xl p-4 w-full max-w-sm shadow-lg shadow-primary/10">
      <div className="flex items-center gap-3 mb-3">
        <div className="w-10 h-10 bg-primary/15 rounded-full flex items-center justify-center animate-pulse border border-primary/30">
          <Check size={20} className="text-primary" />
        </div>
        <div>
          <p className="text-sm font-semibold text-foreground">{botName}</p>
          <p className="text-xs text-muted-foreground font-mono truncate">ID: {agentId}</p>
        </div>
      </div>
      <button
        onClick={() => router.push(`/dashboard/deploy/${agentId}/code`)}
        className="w-full flex items-center justify-center gap-2 border border-secondary/40 text-secondary-foreground bg-secondary/10 hover:bg-secondary/20 hover:border-secondary/50 text-sm font-medium py-2.5 rounded-lg transition-all hover:shadow-lg hover:shadow-primary/10"
      >
        <Terminal size={14} />
        Open in Bot IDE
        <ArrowRight size={12} />
      </button>
    </div>
  )
}

export default function BotConfiguratorPage() {
  const router = useRouter()
  const {
    messages, input, isTyping, isGenerating, chips, bottomRef,
    generatedAgentId, handleSend, handleKeyDown, handleInputChange,
    submitDynamicKeys, submitClarificationKeys, step, envDefaults
  } = useBotConfigChat()

  const textareaRef = useRef<HTMLTextAreaElement>(null)

  return (
    <div className="flex flex-col h-full bg-background min-h-screen text-foreground">
      {/* Header */}
      <div className="flex items-center justify-between px-6 py-4 border-b border-border bg-background/90 backdrop-blur-sm sticky top-0 z-10">
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 rounded-xl bg-gradient-to-br from-primary/20 to-secondary/20 border border-border flex items-center justify-center">
            <Zap size={18} className="text-primary" />
          </div>
          <div>
            <h1 className="text-sm font-bold text-foreground">Universal Meta-Agent</h1>
            <p className="text-xs text-muted-foreground">Describe your strategy in plain English</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {generatedAgentId && (
            <>
              <span className="text-xs text-secondary-foreground bg-secondary/20 px-2 py-1 rounded border border-secondary/30">
                ✓ Bot Ready
              </span>
              <button
                onClick={() => generatedAgentId ? router.push(`/dashboard/deploy/${generatedAgentId}/code`) : router.push('/dashboard/deploy')}
                className="flex items-center gap-2 text-xs border border-primary/30 text-primary hover:bg-primary/10 px-3 py-1.5 rounded-lg transition-colors"
              >
                <Terminal size={12} />
                Open Bot IDE
              </button>
            </>
          )}
          {isGenerating && (
            <span className="text-xs text-secondary-foreground bg-secondary/15 px-2 py-1 rounded border border-secondary/30 animate-pulse">
              ⏳ Generating...
            </span>
          )}
        </div>
      </div>

      {/* Messages */}
      <div className="flex-1 overflow-y-auto py-4 space-y-1">
        {messages.map(msg => (
          <div key={msg.id}>
            {msg.role === 'assistant' ? (
              <div className="flex items-end gap-2.5 px-4 py-1 max-w-2xl">
                <div className="w-7 h-7 rounded-full bg-primary/15 border border-primary/30 flex items-center justify-center flex-shrink-0 mb-1">
                  <Bot size={13} className="text-primary" />
                </div>
                <div className="flex-1 min-w-0">
                  {msg.content && (
                    <div className="bg-card border border-border rounded-2xl rounded-bl-sm px-4 py-3 text-sm text-foreground/90 leading-relaxed whitespace-pre-wrap shadow-sm">
                      {msg.content.split(/(\*\*[^*]+\*\*)/).map((part, i) =>
                        part.startsWith('**') && part.endsWith('**')
                          ? <strong key={i} className="text-secondary-foreground">{part.slice(2, -2)}</strong>
                          : <span key={i}>{part}</span>
                      )}
                    </div>
                  )}
                  {msg.card?.type === 'success_card' && (
                    <SuccessCard agentId={(msg.card as any)?.agentId ?? ""} botName={(msg.card as any)?.botName ?? ""} />
                  )}
                  {msg.card?.type === 'dynamic_credentials_form' && (
                    <DynamicCredentialsCard
                      fields={msg.card.fields ?? []}
                      onSubmit={msg.card.formMode === 'clarification' ? submitClarificationKeys : submitDynamicKeys}
                      disabled={step !== 'ask_keys'}
                      defaultValues={envDefaults}
                    />
                  )}
                  <p className="text-[10px] text-muted-foreground mt-1 ml-1">
                    {msg.timestamp.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                  </p>
                </div>
              </div>
            ) : (
              <div className="flex items-end justify-end gap-2.5 px-4 py-1">
                <div className="max-w-[70%]">
                  <div className="bg-primary/15 border border-primary/30 text-foreground rounded-2xl rounded-br-sm px-4 py-3 text-sm leading-relaxed shadow-sm">
                    {msg.content}
                  </div>
                  <p className="text-[10px] text-muted-foreground mt-1 mr-1 text-right">
                    {msg.timestamp.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                  </p>
                </div>
              </div>
            )}
          </div>
        ))}

        {isTyping && <TypingIndicator />}
        {step === 'generating' && (
          <div className="flex items-end gap-2.5 px-4 py-2">
            <div className="w-7 h-7 rounded-full bg-primary/15 border border-primary/30 flex items-center justify-center flex-shrink-0">
              <Bot size={13} className="text-primary" />
            </div>
            <div className="bg-secondary/10 border border-secondary/30 rounded-2xl rounded-bl-sm px-4 py-3">
              <p className="text-sm text-secondary-foreground flex items-center gap-2">
                <span className="inline-block w-5 h-5 rounded-full border-2 border-secondary/40 border-t-secondary-foreground animate-spin" />
                <span>Meta-Agent is architecting your bot... (this may take 30-60 seconds)</span>
              </p>
            </div>
          </div>
        )}
        <div ref={bottomRef} />
      </div>

      {/* Chip suggestions */}
      {chips.length > 0 && !isGenerating && (
        <div className="flex flex-wrap gap-2 px-4 pb-2">
          {chips.map(chip => (
            <button
              key={chip}
              onClick={() => handleSend(chip)}
              disabled={isGenerating}
              className="text-xs bg-card border border-border hover:border-primary/40 hover:bg-card/80 text-foreground/80 px-3 py-1.5 rounded-full transition-all disabled:opacity-40"
            >
              {chip}
            </button>
          ))}
        </div>
      )}

      {/* Input bar */}
      <div className="px-4 pb-4 pt-2 border-t border-border">
        <div className="flex items-end gap-2 bg-card border border-border focus-within:border-primary/50 rounded-xl px-4 py-2 transition-colors shadow-sm">
          <textarea
            ref={textareaRef}
            value={input}
            onChange={handleInputChange}
            onKeyDown={handleKeyDown}
            disabled={isGenerating}
            placeholder={isGenerating ? 'Generating your custom bot...' : 'Describe your trading strategy...'}
            rows={1}
            className="flex-1 bg-transparent text-sm text-foreground placeholder:text-muted-foreground resize-none outline-none min-h-[24px] max-h-[120px] leading-6 disabled:opacity-50"
          />
          <button
            onClick={() => handleSend()}
            disabled={isGenerating || !input.trim()}
            className="flex-shrink-0 w-8 h-8 flex items-center justify-center bg-primary hover:bg-primary/90 disabled:bg-muted rounded-lg transition-colors"
          >
            {isGenerating ? (
              <div className="w-4 h-4 border-2 border-transparent border-t-primary-foreground rounded-full animate-spin" />
            ) : (
              <Send size={14} className="text-primary-foreground" />
            )}
          </button>
        </div>
        <p className="text-center text-[10px] text-muted-foreground mt-2">
          Powered by Synth Universal Meta-Agent
        </p>
      </div>
    </div>
  )
}