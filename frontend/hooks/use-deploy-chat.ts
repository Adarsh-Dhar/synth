'use client'

import { useState, useRef, useEffect, useCallback, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { useUser } from '@/lib/user-context'
import { useWallet } from '@solana/wallet-adapter-react'
import { useMutation } from '@tanstack/react-query'
import type { AgentPlan, ChatMessage, ConvState, Guardrails } from '../lib/types'
import {
  delay, makeAssistantMsg, makeUserMsg, strategyLabel,
} from '../lib/utils'

export function useDeployChat() {
  const { user } = useUser()
  const { publicKey, connect } = useWallet()
  const openConnect = connect
  const walletAddress = publicKey ? publicKey.toBase58() : ''
  const router                                          = useRouter()
  const [, startTransition]                             = useTransition()

  const autosignEnabled = Boolean(walletAddress)
  const enableAutosign = useMutation({ mutationFn: async () => connect?.() })

  // ── Chat state ────────────────────────────────────────────────────────────
  const [messages,   setMessages]   = useState<ChatMessage[]>([])
  const [input,      setInput]      = useState('')
  const [convState,  setConvState]  = useState<ConvState>('greeting')
  const [isTyping,   setIsTyping]   = useState(false)
  const [chips,      setChips]      = useState<string[]>([])

  // ── Plan / deploy state ───────────────────────────────────────────────────
  const [currentPlan,       setCurrentPlan]       = useState<AgentPlan | null>(null)
  const [currentGuardrails, setCurrentGuardrails] = useState<Guardrails | null>(null)
  const [pendingEditField,  setPendingEditField]   = useState<string | null>(null)
  const [deployedAgentId,   setDeployedAgentId]   = useState<string | null>(null)
  const [agentAddress,      setAgentAddress]       = useState('')
  const [deployedAgentName, setDeployedAgentName] = useState('')
  const [showDeposit,       setShowDeposit]        = useState(false)
  const [isDepositing,      setIsDepositing]       = useState(false)
  const [depositError,      setDepositError]       = useState<string | null>(null)

  const bottomRef   = useRef<HTMLDivElement>(null)
  const inputRef    = useRef<HTMLTextAreaElement>(null)
  const initialized = useRef(false)

  // ── Auto-scroll ───────────────────────────────────────────────────────────
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages, isTyping, chips, showDeposit])

  // ── Greeting ──────────────────────────────────────────────────────────────
  useEffect(() => {
    if (initialized.current) return
    initialized.current = true

    const greet = async () => {
      setIsTyping(true)
      await delay(900)
      setIsTyping(false)
      pushAssistant(
        `Hey there! I'm your agent-creation assistant. 👋\n\nTell me what you want to achieve — your trading goal, how much risk you're comfortable with, and roughly how long you want the agent to run.\n\nI'll design a complete strategy and deploy it for you.`
      )
      await delay(400)
      setChips([
        'Snipe meme tokens, low risk',
        'Arbitrage token pairs, 48h',
        'Sentiment trading, $500 max',
      ])
      setConvState('collecting')
    }

    greet()
  }, [])

  // ── Message helpers ───────────────────────────────────────────────────────
  function pushAssistant(content: string, card?: ChatMessage['card']) {
    setMessages(prev => [...prev, makeAssistantMsg(content, card)])
  }

  function pushUser(content: string) {
    setMessages(prev => [...prev, makeUserMsg(content)])
  }

  // ── Build plan ────────────────────────────────────────────────────────────
  async function buildPlan(intent: string) {
    if (!user?.id) {
      pushAssistant("I can't create an agent — you're not logged in. Please connect your wallet first.", {
        type: 'error', message: 'Not authenticated',
      })
      return
    }

    setConvState('drafting')
    setIsTyping(true)
    setChips([])

    try {
      const res  = await fetch('/api/agent-creation', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ userId: user.id, intent }),
      })
      const data = await res.json()

      if (!res.ok) {
        throw new Error(data?.details?.aiError ?? data?.error ?? `Request failed (${res.status})`)
      }

      const plan = data.plan as AgentPlan & {
        appliedSpendAllowance: number
        appliedSessionHours:   number
        appliedMaxDailyLoss:   number
      }

      // Clean up the provisional agent created server-side
      if (data.agent?.id) {
        await fetch(`/api/agent/${data.agent.id}`, { method: 'DELETE' }).catch(() => {})
      }

      setCurrentPlan(plan)
      setCurrentGuardrails({
        spendAllowance:       plan.appliedSpendAllowance,
        sessionDurationHours: plan.appliedSessionHours,
        maxDailyLoss:         plan.appliedMaxDailyLoss,
      })

      await delay(600)
      setIsTyping(false)
      pushAssistant(
        `Here's the mission plan I designed for you. It uses the **${strategyLabel(plan.strategy)}** strategy on **${plan.targetPair}**.\n\nReview the entry/exit conditions and stats below. You can approve it or ask me to revise anything.`,
        { type: 'plan', plan }
      )
      setConvState('reviewing_plan')

    } catch (err) {
      setIsTyping(false)
      const msg = err instanceof Error ? err.message : 'Something went wrong. Please try again.'
      pushAssistant(
        `I ran into a problem drafting your plan:\n\n_${msg}_\n\nCould you rephrase your goal? Try being more specific about the strategy, risk tolerance, or time horizon.`,
        { type: 'error', message: msg }
      )
      setConvState('collecting')
      setChips(['Try again', 'Use arbitrage strategy', 'Keep it simple'])
    }
  }

  // ── Approve plan ──────────────────────────────────────────────────────────
  async function handleApprovePlan() {
    if (!currentPlan || !currentGuardrails) return
    setConvState('guardrails')
    setChips([])
    setIsTyping(true)
    await delay(700)
    setIsTyping(false)
    pushAssistant(
      `Great! Now let's lock in your **hard guardrails** — these limits are enforced by the session key and the agent can never override them.\n\nI've pre-filled them based on your intent. You can change any value by tapping "change" or just say _"change spend limit to $300"_.`,
      { type: 'confirm', plan: currentPlan, guardrails: currentGuardrails }
    )
  }

  // ── Guardrail field edit ──────────────────────────────────────────────────
  async function handleGuardrailEditRequest(field: string) {
    const labels: Record<string, string> = {
      spendAllowance:       'spending limit (in USD)',
      sessionDurationHours: 'session duration (in hours)',
      maxDailyLoss:         'max daily loss (in USD)',
    }
    setPendingEditField(field)
    setIsTyping(true)
    await delay(500)
    setIsTyping(false)
    pushAssistant(`Sure — what should the new **${labels[field] ?? field}** be?`)
  }

  // ── Deploy ────────────────────────────────────────────────────────────────
  async function handleDeploy() {
    if (!currentPlan || !currentGuardrails || !user?.id || !walletAddress) return
    if (!autosignEnabled) {
      pushAssistant('Please connect your wallet before deploying or starting bots.')
      return
    }

    // For now we use the connected wallet as the session address. This may be
    // replaced by a server-side session key flow later.
    const sessionAddress = String(walletAddress).trim()
    if (!sessionAddress) {
      pushAssistant('Wallet session unavailable. Connect your wallet and try again.')
      return
    }

    setConvState('deploying')
    setChips([])
    setIsTyping(true)

    try {
      const res  = await fetch('/api/agent-creation', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({
          userId:               user.id,
          intent:               `Deploy: ${currentPlan.agentName} — ${currentPlan.description}`,
          spendAllowance:       currentGuardrails.spendAllowance,
          sessionDurationHours: currentGuardrails.sessionDurationHours,
          maxDailyLoss:         currentGuardrails.maxDailyLoss,
          sessionAddress,
        }),
      })
      const data = await res.json()

      if (!res.ok) {
        throw new Error(data?.details?.aiError ?? data?.error ?? `Deploy failed (${res.status})`)
      }

      const agentId = data.agent.id as string
      setDeployedAgentId(agentId)
      setDeployedAgentName(currentPlan.agentName)
      setAgentAddress(sessionAddress)

      await delay(500)
      setIsTyping(false)
      pushAssistant(
        `🎉 **${currentPlan.agentName}** is deployed and running on Solana!\n\nOne last step — fund the agent wallet so it can execute trades. You can skip this and do it later from the dashboard.`,
        { type: 'deployed', agentName: currentPlan.agentName, agentId }
      )
      setConvState('deposit')
      setShowDeposit(true)

    } catch (err) {
      setIsTyping(false)
      const msg = err instanceof Error ? err.message : 'Deployment failed.'
      pushAssistant(
        `Deployment hit an error:\n\n_${msg}_\n\nWant to try again?`,
        { type: 'error', message: msg }
      )
      setConvState('guardrails')
      setChips(['Try deploying again'])
    }
  }

  // ── Deposit ───────────────────────────────────────────────────────────────
  async function handleDeposit(amount: string) {
    if (!walletAddress || !agentAddress) return
    setIsDepositing(true)
    setDepositError(null)

    try {
      const parsed = parseFloat(amount)
      if (isNaN(parsed) || parsed <= 0) throw new Error('Invalid deposit amount.')

      // Delegate the actual Solana transfer to a backend endpoint which can
      // construct and (optionally) sign/send the transaction. Frontend sends
      // the amount in SOL and the server handles RPC logic.
      const res = await fetch('/api/solana/send-funds', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ from: walletAddress, to: agentAddress, amountSol: parsed }),
      })

      if (!res.ok) {
        const txt = await res.text().catch(() => '')
        throw new Error(`Transfer failed (${res.status}): ${txt.slice(0, 300)}`)
      }

      setShowDeposit(false)
      setIsDepositing(false)
      setConvState('done')

      setIsTyping(true)
      await delay(600)
      setIsTyping(false)
      pushAssistant(`Funds received! Your agent is fully operational. Head to the dashboard to monitor its trades in real time.`)
      setChips(['Go to dashboard'])

    } catch (err) {
      setDepositError(err instanceof Error ? err.message : 'Transaction failed.')
      setIsDepositing(false)
    }
  }

  function handleSkipDeposit() {
    setShowDeposit(false)
    setConvState('done')
    startTransition(() => {
      setIsTyping(true)
      delay(500).then(() => {
        setIsTyping(false)
        pushAssistant(`No problem — you can fund it anytime from the agent's detail page. Your agent is registered and will start once it has funds.`)
        setChips(['Go to dashboard'])
      })
    })
  }

  // ── Send dispatcher ───────────────────────────────────────────────────────
  const handleSend = useCallback(async (rawInput?: string) => {
    const text  = (rawInput ?? input).trim()
    if (!text) return
    setInput('')
    setChips([])
    pushUser(text)

    const lower = text.toLowerCase()

    if (lower.includes('dashboard')) {
      router.push('/dashboard')
      return
    }

    if (convState === 'collecting' || convState === 'greeting') {
      if (text.length < 10) {
        setIsTyping(true)
        await delay(600)
        setIsTyping(false)
        pushAssistant(`Could you say a bit more? Even a short description like "low-risk arb trades for 24 hours" helps me design the right strategy.`)
        return
      }
      await buildPlan(text)
      return
    }

    if (convState === 'reviewing_plan' && currentPlan) {
      if (/approve|looks good|let'?s go|yes|deploy|accept|perfect|great/i.test(lower)) {
        await handleApprovePlan()
        return
      }
      if (/revise|change|edit|different|no|update|adjust/i.test(lower)) {
        setIsTyping(true)
        await delay(500)
        setIsTyping(false)
        pushAssistant(`Of course! Tell me what you'd like to change — different strategy, trading pair, risk level, duration?`)
        setConvState('collecting')
        return
      }
      setIsTyping(true)
      await delay(500)
      setIsTyping(false)
      pushAssistant(`Got it — let me redesign the plan with that in mind.`)
      await buildPlan(`Original goal: ${currentPlan.description}. Adjustment: ${text}`)
      return
    }

    if (convState === 'guardrails' && currentGuardrails) {
      if (pendingEditField) {
        const num = parseFloat(text.replace(/[^0-9.]/g, ''))
        if (isNaN(num) || num <= 0) {
          setIsTyping(true)
          await delay(400)
          setIsTyping(false)
          pushAssistant(`That doesn't look like a valid number. What should the new value be?`)
          return
        }
        const fieldLabels: Record<string, string> = {
          spendAllowance:       `spending limit to $${num.toLocaleString()}`,
          sessionDurationHours: `session duration to ${num} hours`,
          maxDailyLoss:         `max daily loss to $${num.toLocaleString()}`,
        }
        setCurrentGuardrails(prev => prev ? { ...prev, [pendingEditField]: num } : prev)
        setPendingEditField(null)
        setIsTyping(true)
        await delay(500)
        setIsTyping(false)
        pushAssistant(`Updated! I've set the ${fieldLabels[pendingEditField] ?? pendingEditField}. Anything else to adjust, or shall we deploy?`)
        setChips(['Deploy now', 'Change something else'])
        return
      }

      // Natural language edits
      const spendMatch = text.match(/spend(?:ing)?(?:\s+limit)?\s+(?:to\s+)?\$?([\d,]+)/i)
      const hoursMatch = text.match(/(?:session\s+)?(?:duration|hours?)\s+(?:to\s+)?([\d]+)/i)
      const lossMatch  = text.match(/(?:daily\s+)?loss\s+(?:to\s+)?\$?([\d,]+)/i)

      let updated   = false
      let updateMsg = ''

      if (spendMatch) {
        const v = parseFloat(spendMatch[1].replace(',', ''))
        setCurrentGuardrails(p => p ? { ...p, spendAllowance: v } : p)
        updateMsg += `spending limit → $${v.toLocaleString()} `
        updated = true
      }
      if (hoursMatch) {
        const v = parseFloat(hoursMatch[1])
        setCurrentGuardrails(p => p ? { ...p, sessionDurationHours: v } : p)
        updateMsg += `session → ${v}h `
        updated = true
      }
      if (lossMatch) {
        const v = parseFloat(lossMatch[1].replace(',', ''))
        setCurrentGuardrails(p => p ? { ...p, maxDailyLoss: v } : p)
        updateMsg += `max loss → $${v.toLocaleString()} `
        updated = true
      }

      if (updated) {
        setIsTyping(true)
        await delay(500)
        setIsTyping(false)
        pushAssistant(`Updated: ${updateMsg.trim()}. Ready to deploy, or change anything else?`)
        setChips(['Deploy now', 'Change something else'])
        return
      }

      if (/deploy|confirm|yes|go|launch|let'?s do it/i.test(lower)) {
        await handleDeploy()
        return
      }

      setIsTyping(true)
      await delay(400)
      setIsTyping(false)
      pushAssistant(`I can update the spending limit, session duration, or max daily loss — or just say "deploy" when you're ready.`)
      return
    }

    if (convState === 'deploying') {
      setIsTyping(true)
      await delay(400)
      setIsTyping(false)
      pushAssistant(`Still deploying — hang tight for a moment!`)
      return
    }

    if (/try again|retry|again/i.test(lower)) {
      if (currentPlan && currentGuardrails && convState === 'guardrails') {
        await handleDeploy()
      } else {
        setConvState('collecting')
        setIsTyping(true)
        await delay(400)
        setIsTyping(false)
        pushAssistant(`Sure, let's try again. What's your trading goal?`)
      }
      return
    }

    setIsTyping(true)
    await delay(500)
    setIsTyping(false)
    pushAssistant(
      convState === 'done'
        ? `Your agent is already deployed — head to the dashboard to monitor it.`
        : `Try describing your trading goal and I'll build a plan.`
    )
    if (convState === 'done') setChips(['Go to dashboard'])

  }, [input, convState, currentPlan, currentGuardrails, pendingEditField, user, walletAddress, router])

  // ── Input handlers ────────────────────────────────────────────────────────
  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSend()
    }
  }

  const handleInputChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setInput(e.target.value)
    e.target.style.height = 'auto'
    e.target.style.height = Math.min(e.target.scrollHeight, 120) + 'px'
  }

  const isBusy = convState === 'drafting' || convState === 'deploying' || isTyping

  return {
    // State
    messages,
    input,
    convState,
    isTyping,
    chips,
    isBusy,
    currentGuardrails,
    deployedAgentId,
    deployedAgentName,
    agentAddress,
    showDeposit,
    isDepositing,
    depositError,
    autosignEnabled,
    enableAutosign,
    walletAddress,
    // Refs
    bottomRef,
    inputRef,
    // Handlers
    handleSend,
    handleKeyDown,
    handleInputChange,
    handleApprovePlan,
    handleDeploy,
    handleGuardrailEditRequest,
    handleDeposit,
    handleSkipDeposit,
    setConvState,
  }
}