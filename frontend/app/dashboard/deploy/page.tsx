'use client'

import Link from 'next/link'
import { Bot, ChevronLeft, Send, ShieldCheck, ShieldOff } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useDeployChat }   from "@/hooks/use-deploy-chat"
import { MessageList }     from '@/components/message-list'
import { Chips }           from '@/components/ui/chips'
import { DepositModal }    from '@/components/deposit-modal'

import { useRouter } from 'next/navigation'
import { useState } from 'react'
import { useWallet } from '@solana/wallet-adapter-react'
import { getWalletAuthHeaders } from '@/lib/auth/client'

export default function DeployChatPage() {
  const router = useRouter();
  const { publicKey, signMessage } = useWallet();
  const [creatingBot, setCreatingBot] = useState(false);

  // Handler for the Create Bot button
  async function handleCreateBot() {
    setCreatingBot(true);
    try {
      const authHeaders = await getWalletAuthHeaders({ publicKey, signMessage });
      // Call the get-bot-code API to create a new bot and agent in DB
      const res = await fetch('/api/get-bot-code', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(authHeaders ?? {}) },
        body: JSON.stringify({}),
      });
      if (!res.ok) {
        throw new Error('Failed to create bot');
      }
      const data = await res.json();
      const agentId = data.agentId;
      if (!agentId) throw new Error('No agentId returned');
      // Route to the code page for the new agent
      router.push(`/dashboard/deploy/${agentId}/code`);
    } catch {
      alert('Failed to create bot. Please try again.');
      // Optionally log error
      // console.error(err);
    } finally {
      setCreatingBot(false);
    }
  }
  const {
    messages, input, convState, isTyping, chips, isBusy,
    currentGuardrails,
    deployedAgentName, agentAddress,
    showDeposit, isDepositing, depositError,
    autosignEnabled, enableAutosign, walletAddress,
    bottomRef, inputRef,
    handleSend, handleKeyDown, handleInputChange,
    handleApprovePlan, handleDeploy, handleGuardrailEditRequest,
    handleDeposit, handleSkipDeposit,
    setConvState,
  } = useDeployChat()

  const inputPlaceholder =
    convState === 'done'           ? 'Ask me anything…'
    : convState === 'reviewing_plan' ? 'Say "approve" or describe changes…'
    : convState === 'guardrails'     ? 'Adjust limits or say "deploy"…'
    : 'Describe your trading goal…'

  return (
    <>
      {/* ── Create Bot Button ── */}
      <div className="flex justify-end p-4">
        <Button
          onClick={handleCreateBot}
          disabled={creatingBot}
          className="bg-primary text-white"
        >
          {creatingBot ? 'Creating Bot…' : 'Create Bot'}
        </Button>
      </div>
      {showDeposit && (
        <DepositModal
          agentName={deployedAgentName}
          agentAddress={agentAddress}
          onDeposit={handleDeposit}
          onSkip={handleSkipDeposit}
          isDepositing={isDepositing}
          error={depositError}
        />
      )}

      <div className="flex flex-col h-screen bg-background">

        {/* ── Top bar ── */}
        <div className="flex-shrink-0 bg-background border-b border-border px-4 py-3 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <Link href="/dashboard">
              <Button variant="ghost" size="sm" className="text-muted-foreground">
                <ChevronLeft size={18} />
              </Button>
            </Link>
            <div className="flex items-center gap-2.5">
              <div className="w-8 h-8 rounded-xl bg-gradient-to-br from-primary/30 to-secondary/30 border border-primary/20 flex items-center justify-center">
                <Bot size={15} className="text-primary" />
              </div>
              <div>
                <p className="text-sm font-semibold leading-none">Agent Creator</p>
                <p className="text-xs text-muted-foreground mt-0.5 flex items-center gap-1">
                  <span className="w-1.5 h-1.5 rounded-full bg-green-400 inline-block" />
                  Powered by gpt-4o
                </p>
              </div>
            </div>
          </div>

          <button
            onClick={() => !autosignEnabled && enableAutosign.mutate()}
            disabled={autosignEnabled || enableAutosign.isPending}
            className={`flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-full border transition-all ${
              autosignEnabled
                ? 'bg-green-500/10 border-green-500/30 text-green-400'
                : 'bg-yellow-500/10 border-yellow-500/30 text-yellow-400 hover:bg-yellow-500/20'
            }`}
          >
            {autosignEnabled
              ? <><ShieldCheck size={12} /> Autosign on</>
              : <><ShieldOff  size={12} /> {enableAutosign.isPending ? 'Enabling…' : 'Enable autosign'}</>
            }
          </button>
        </div>

        {/* ── Messages ── */}
        <MessageList
          messages={messages}
          isTyping={isTyping}
          convState={convState}
          currentGuardrails={currentGuardrails}
          bottomRef={bottomRef}
          onApprovePlan={handleApprovePlan}
          onEditPlan={() => {
            setConvState('collecting')
          }}
          onConfirmDeploy={handleDeploy}
          onEditGuardrail={handleGuardrailEditRequest}
        />

        {/* ── Quick-reply chips ── */}
        {chips.length > 0 && !isBusy && (
          <Chips options={chips} onSelect={t => handleSend(t)} disabled={isBusy} />
        )}

        {/* ── Input bar ── */}
        <div className="flex-shrink-0 bg-background border-t border-border px-4 py-3">
          {!walletAddress && (
            <p className="text-xs text-destructive text-center mb-2">
              Connect your wallet to deploy agents.
            </p>
          )}
          <div className="flex items-end gap-2 bg-card border border-border rounded-2xl px-4 py-2.5 focus-within:border-primary/50 transition-colors">
            <textarea
              ref={inputRef}
              rows={1}
              value={input}
              onChange={handleInputChange}
              onKeyDown={handleKeyDown}
              disabled={isBusy}
              placeholder={inputPlaceholder}
              className="flex-1 bg-transparent text-foreground text-sm placeholder:text-muted-foreground resize-none focus:outline-none min-h-[24px] max-h-[120px] leading-6 disabled:opacity-50"
              style={{ height: '24px' }}
            />
            <Button
              size="sm"
              onClick={() => handleSend()}
              disabled={isBusy || !input.trim()}
              className="h-8 w-8 p-0 rounded-xl flex-shrink-0 bg-primary hover:bg-primary/90 disabled:opacity-40"
            >
              <Send size={14} />
            </Button>
          </div>
          <p className="text-[10px] text-muted-foreground/40 text-center mt-2">
            Enter to send · Shift+Enter for new line
          </p>
        </div>
      </div>
    </>
  )
}