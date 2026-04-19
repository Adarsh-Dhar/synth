/**
 * frontend/hooks/use-bot-config-chat.ts
 *
 * Multi-turn Planner Agent chat hook.
 *
 * KEY ADDITIONS (AutoSign wallet integration):
 *  1. Reads `address` from the connected wallet adapter on every send.
 *  2. If wallet NOT connected → shows an inline blocking message and returns early.
 *     No API call is made until the user connects.
 *  3. If wallet IS connected → silently prepends a `system` message to the
 *     payload (never shown in the UI) that tells the Planner Agent:
 *       "USER_WALLET_ADDRESS = <hex 0x address>"
 *     The Planner reads this, satisfies the USER_WALLET_ADDRESS requirement,
 *     and never asks the user for it.
 *  4. USER_WALLET_ADDRESS is removed from all credential forms because it is
 *     already known from the session.
 *  5. The greeting shows a live wallet badge so the user knows their address
 *     has been detected.
 */

"use client";

import {
  useState,
  useRef,
  useCallback,
  useEffect,
  ChangeEvent,
  KeyboardEvent,
} from "react";
import { v4 as uuidv4 } from "uuid";
import { useWallet } from "@solana/wallet-adapter-react";
import bs58 from 'bs58'
import { getWalletAuthHeaders } from '@/lib/auth/client'

// ─── Types ────────────────────────────────────────────────────────────────────

export type MessageRole = "user" | "assistant";

export interface ChatCard {
  type: "dynamic_credentials_form" | "success_card";
  fields?: CredentialField[];
  agentId?: string;
  botName?: string;
}

export interface ChatMessage {
  id: string;
  role: MessageRole;
  content: string;
  timestamp: Date;
  card?: ChatCard;
}

export interface CredentialField {
  key: string;
  label: string;
  placeholder: string;
  type?: "text" | "password";
  required?: boolean;
}

export type Step =
  | "idle"
  | "classifying"
  | "planning"
  | "ask_keys"
  | "generating"
  | "done";

// ─── Credential field schemas
// USER_WALLET_ADDRESS intentionally excluded from ALL schemas —
// it is always resolved from the connected AutoSign wallet session.
// ─────────────────────────────────────────────────────────────────────────────

const STRATEGY_FIELDS: Record<string, CredentialField[]> = {
  yield: [
    {
      key: "SOLANA_BRIDGE_ADDRESS",
      label: "Bridge Program ID (base58)",
      placeholder: "So11111111111111111111111111111111111111112",
      required: true,
    },
    {
      key: "SOLANA_USDC_MINT",
      label: "USDC Mint Address (base58)",
      placeholder: "Base58 USDC mint address",
      required: true,
    },
    {
      key: "MCP_GATEWAY_URL",
      label: "MCP Gateway URL",
      placeholder: "http://localhost:8000/mcp",
      required: true,
    },
  ],
  arbitrage: [
    {
      key: "SOLANA_POOL_A_ADDRESS",
      label: "Pool A Address (base58)",
      placeholder: "Base58 pool address",
      required: true,
    },
    {
      key: "SOLANA_POOL_B_ADDRESS",
      label: "Pool B Address (base58)",
      placeholder: "Base58 pool address",
      required: true,
    },
    {
      key: "SOLANA_USDC_MINT",
      label: "USDC Mint Address (base58)",
      placeholder: "Base58 USDC mint address",
      required: true,
    },
    {
      key: "SOLANA_SWAP_ROUTER_ADDRESS",
      label: "Swap Router Program ID (base58)",
      placeholder: "Base58 router program id",
      required: true,
    },
    {
      key: "SOLANA_EXECUTION_AMOUNT_USDC",
      label: "Execution Amount (µUSDC)",
      placeholder: "1000000",
      required: true,
    },
    {
      key: "MCP_GATEWAY_URL",
      label: "MCP Gateway URL",
      placeholder: "http://localhost:8000/mcp",
      required: true,
    },
  ],
  cross_chain_liquidation: [
    {
      key: "SOLANA_MOCK_ORACLE_ADDRESS",
      label: "Mock Oracle Address (base58)",
      placeholder: "Base58 oracle address",
      required: true,
    },
    {
      key: "SOLANA_MOCK_LENDING_ADDRESS",
      label: "Mock Lending Address (base58)",
      placeholder: "Base58 lending program id",
      required: true,
    },
    {
      key: "SOLANA_LIQUIDATION_WATCHLIST",
      label: "Liquidation Watchlist",
      placeholder: "address1,address2",
      required: true,
    },
    {
      key: "MCP_GATEWAY_URL",
      label: "MCP Gateway URL",
      placeholder: "http://localhost:8000/mcp",
      required: true,
    },
  ],
  cross_chain_arbitrage: [
    {
      key: "SOLANA_POOL_A_ADDRESS",
      label: "Pool A Address (buy side)",
      placeholder: "Base58 pool address",
      required: true,
    },
    {
      key: "SOLANA_POOL_B_ADDRESS",
      label: "Pool B Address (sell side)",
      placeholder: "Base58 pool address",
      required: true,
    },
    {
      key: "SOLANA_USDC_MINT",
      label: "USDC Mint Address (base58)",
      placeholder: "Base58 USDC mint address",
      required: true,
    },
    {
      key: "SOLANA_EXECUTION_AMOUNT_USDC",
      label: "Execution Amount (µUSDC)",
      placeholder: "1000000",
      required: true,
    },
    {
      key: "MCP_GATEWAY_URL",
      label: "MCP Gateway URL",
      placeholder: "http://localhost:8000/mcp",
      required: true,
    },
  ],
  cross_chain_sweep: [
    {
      key: "SOLANA_BRIDGE_ADDRESS",
      label: "Bridge Program ID (base58)",
      placeholder: "So11111111111111111111111111111111111111112",
      required: true,
    },
    {
      key: "SOLANA_USDC_MINT",
      label: "USDC Mint Address (base58)",
      placeholder: "Base58 USDC mint address",
      required: true,
    },
    {
      key: "MCP_GATEWAY_URL",
      label: "MCP Gateway URL",
      placeholder: "http://localhost:8000/mcp",
      required: true,
    },
  ],
  sentiment: [
    {
      key: "SOLANA_POOL_A_ADDRESS",
      label: "Pool A Address",
      placeholder: "Base58 pool address",
      required: true,
    },
    {
      key: "SOLANA_POOL_B_ADDRESS",
      label: "Pool B Address",
      placeholder: "Base58 pool address",
      required: true,
    },
    {
      key: "MCP_GATEWAY_URL",
      label: "MCP Gateway URL",
      placeholder: "http://localhost:8000/mcp",
      required: true,
    },
  ],
  custom_utility: [
    {
      key: "MCP_GATEWAY_URL",
      label: "MCP Gateway URL",
      placeholder: "http://localhost:8000/mcp",
      required: true,
    },
  ],
};

const FALLBACK_FIELDS: CredentialField[] = [
  {
    key: "MCP_GATEWAY_URL",
    label: "MCP Gateway URL",
    placeholder: "http://localhost:8000/mcp",
    required: true,
  },
];

const INITIAL_CHIPS = [
  "Yield sweeper bot",
  "Cross-chain arbitrage bot",
  "Spread scanner bot",
  "Custom utility bot",
];

// ─── Helpers ──────────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function truncateAddr(addr: string): string {
  if (addr.length <= 16) return addr;
  return `${addr.slice(0, 8)}…${addr.slice(-6)}`;
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function toHexWalletAddress(addr: string): string {
  const trimmed = addr.trim();
  if (!trimmed) return "";

  if (trimmed.startsWith("0x")) {
    return `0x${trimmed.slice(2).toLowerCase()}`;
  }

  // Try base58 (Solana)
  try {
    const bytes = bs58.decode(trimmed);
    return `0x${bytesToHex(bytes)}`;
  } catch {
    return "";
  }
}

// ─── Hook ─────────────────────────────────────────────────────────────────────

interface ServerMessage {
  role: "user" | "assistant" | "system";
  content: string;
}

export function useBotConfigChat() {
  // ── AutoSign / wallet adapter (Solana) ──────────────────────────────────
  //
  // Wallet adapter: Solana publicKey (base58) will be used when available.
  const { publicKey, connect, signMessage } = useWallet();
  const openConnect = connect;

  const walletAddress = publicKey ? publicKey.toBase58() : "";
  const walletHexAddress = toHexWalletAddress(walletAddress);
  const walletDisplayAddress = walletHexAddress || walletAddress;
  const isWalletConnected = Boolean(walletAddress) && Boolean(walletHexAddress);

  // ── Chat state ───────────────────────────────────────────────────────────
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [step, setStep] = useState<Step>("idle");
  const [isTyping, setIsTyping] = useState(false);
  const [isGenerating, setIsGenerating] = useState(false);
  const [chips, setChips] = useState<string[]>(INITIAL_CHIPS);
  const [generatedAgentId, setGeneratedAgentId] = useState<string | null>(null);
  const [envDefaults, setEnvDefaults] = useState<Record<string, string>>({});

  // Full conversation history forwarded to Python on every turn
  const chatHistoryRef = useRef<ServerMessage[]>([]);
  const detectedStrategyRef = useRef<string>("custom_utility");
  const expandedPromptRef = useRef<string>("");
  const requestIdRef = useRef<string>(uuidv4());
  const greetingShownRef = useRef(false);

  const pendingBotRef = useRef<{
    files: Record<string, unknown>[];
    intent: Record<string, unknown>;
    botName: string;
  } | null>(null);

  const bottomRef = useRef<HTMLDivElement>(null);

  // ── Auto-scroll ───────────────────────────────────────────────────────────

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, isTyping]);

  // ── Load env defaults ─────────────────────────────────────────────────────

  useEffect(() => {
    fetch("/api/env-defaults")
      .then((r) => r.json())
      .then((data) => {
        if (data?.values && typeof data.values === "object") {
          setEnvDefaults(data.values as Record<string, string>);
        }
      })
      .catch(() => {});
  }, []);

  // ── Greeting (once, wallet-aware) ─────────────────────────────────────────

  useEffect(() => {
    if (greetingShownRef.current) return;
    greetingShownRef.current = true;

    const walletLine = isWalletConnected
      ? `\n\n✅ **Wallet detected:** \`${truncateAddr(walletDisplayAddress)}\` — I'll use this as your bot's wallet address automatically. You won't need to paste it anywhere.`
      : `\n\n⚠️ **No wallet connected.** Please connect your wallet before generating a bot — I need your address to configure it correctly.`;

    setMessages([
      {
        id: uuidv4(),
        role: "assistant",
        content:
          "👋 Hi! I'm the **Planner Agent** — I'll help you design and generate a production-ready " +
          "Solana bot.\n\n" +
          "Tell me what you want your bot to do. I'll verify your addresses on-chain, ask for anything " +
          "that's missing, and then generate the complete TypeScript code." +
          walletLine +
          "\n\nWhat kind of bot are you building?",
        timestamp: new Date(),
      },
    ]);
    // Run only on mount — wallet state is handled by the mid-session effect below
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Mid-session wallet connect notification ───────────────────────────────

  const prevConnectedRef = useRef(isWalletConnected);
  useEffect(() => {
    if (!prevConnectedRef.current && isWalletConnected && walletDisplayAddress) {
      prevConnectedRef.current = true;
      setMessages((prev) => [
        ...prev,
        {
          id: uuidv4(),
          role: "assistant" as MessageRole,
          content:
            `✅ **Wallet connected:** \`${truncateAddr(walletDisplayAddress)}\`\n\n` +
            `Your address is now registered. I'll use it automatically for any bot I generate — no need to paste it. ` +
            `You can now describe the bot you'd like to build!`,
          timestamp: new Date(),
        },
      ]);
    }
  }, [isWalletConnected, walletDisplayAddress]);

  // ── Append helpers ────────────────────────────────────────────────────────

  const appendMessage = useCallback(
    (role: MessageRole, content: string, card?: ChatCard): ChatMessage => {
      const msg: ChatMessage = { id: uuidv4(), role, content, timestamp: new Date(), card };
      setMessages((prev) => [...prev, msg]);
      return msg;
    },
    []
  );

  const appendAssistant = useCallback(
    (content: string, card?: ChatCard) => appendMessage("assistant", content, card),
    [appendMessage]
  );

  const pushHistory = useCallback(
    (role: "user" | "assistant", content: string) => {
      chatHistoryRef.current = [...chatHistoryRef.current, { role, content }];
    },
    []
  );

  // ── Build enriched payload with SILENT wallet system message ─────────────
  //
  // This system message is injected at the top of every payload sent to Python.
  // It is never rendered in the chat UI. The Planner reads it, satisfies
  // USER_WALLET_ADDRESS from missing_parameters, and moves on.

  const buildPayload = useCallback(
    (extraContext?: string): ServerMessage[] => {
      const systemMessages: ServerMessage[] = [];

      if (walletHexAddress) {
        systemMessages.push({
          role: "system",
          content:
            `System Context (injected by frontend, not visible to user): ` +
            `The user's AutoSign wallet address in hex format is "${walletHexAddress}". ` +
            `This FULLY SATISFIES the USER_WALLET_ADDRESS parameter requirement. ` +
            `Do NOT ask the user for their wallet address under any circumstances — it is confirmed. ` +
            `Treat USER_WALLET_ADDRESS="${walletHexAddress}" as already collected and verified.`,
        });
      }

      const history = chatHistoryRef.current;

      const expandedCtx: ServerMessage[] =
        expandedPromptRef.current && history.length <= 2
          ? [
              {
                role: "system",
                content: `Expanded technical specification:\n${expandedPromptRef.current}`,
              },
            ]
          : [];

      const extraCtx: ServerMessage[] = extraContext
        ? [{ role: "system", content: extraContext }]
        : [];

      // [wallet context] → [conversation] → [expanded spec] → [extra]
      return [...systemMessages, ...history, ...expandedCtx, ...extraCtx];
    },
    [walletHexAddress]
  );

  // ── Call /create-bot-chat ─────────────────────────────────────────────────

  const callPlannerAgent = useCallback(
    async (additionalContext?: string): Promise<void> => {
      setStep("planning");
      setIsGenerating(true);
      setChips([]);

      try {
        const payload = buildPayload(additionalContext);

        const res = await fetch(
          `${process.env.NEXT_PUBLIC_META_AGENT_URL ?? "http://127.0.0.1:8000"}/create-bot-chat`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              messages: payload,
              request_id: requestIdRef.current,
            }),
          }
        );

        if (!res.ok) {
          const errText = await res.text().catch(() => "");
          throw new Error(`Meta-Agent HTTP ${res.status}: ${errText.slice(0, 300)}`);
        }

        const data = await res.json();

        // ── clarification_needed ─────────────────────────────────────────────
        if (data.status === "clarification_needed") {
          const question = String(data.question ?? "Could you provide more details?");
          setIsTyping(true);
          await sleep(600);
          setIsTyping(false);
          appendAssistant(question);
          pushHistory("assistant", question);
          setStep("idle");
          return;
        }

        // ── ready ─────────────────────────────────────────────────────────────
        if (data.status === "ready") {
          const botName = String(data.bot_name ?? "Your Bot");
          const intent = data.intent ?? {};
          const files = data.files ?? [];

          const strategy = String(
            intent.strategy ?? detectedStrategyRef.current ?? "custom_utility"
          );
          const fields = STRATEGY_FIELDS[strategy] ?? FALLBACK_FIELDS;

          // Build the base env already containing the wallet address
          const knownValues: Record<string, string> = {
            ...envDefaults,
            ...(walletHexAddress
              ? { USER_WALLET_ADDRESS: walletHexAddress }
              : {}),
          };

          // Show only fields not already satisfied by env defaults or wallet
          const filteredFields = fields.filter(
            (f) =>
              f.key !== "USER_WALLET_ADDRESS" && // always pre-filled from wallet
              (!knownValues[f.key] || knownValues[f.key].trim() === "")
          );

          const allPresent = filteredFields.filter((f) => f.required).length === 0;

          if (allPresent) {
            await finalizeBot({ files, intent, botName, envConfig: knownValues });
            return;
          }

          setIsTyping(true);
          await sleep(500);
          setIsTyping(false);

          appendAssistant(
            `✅ **${botName}** is architecturally complete!\n\n` +
              `Your wallet \`${truncateAddr(walletDisplayAddress)}\` is registered as the bot wallet. ` +
              `I just need a few more contract details to finish:`,
            {
              type: "dynamic_credentials_form",
              fields: filteredFields,
            }
          );

          pendingBotRef.current = { files, intent, botName };
          setStep("ask_keys");
          return;
        }

        // ── error ─────────────────────────────────────────────────────────────
        appendAssistant(`❌ ${String(data.message ?? "An unknown error occurred.")}`);
        setStep("idle");
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error("[callPlannerAgent]", msg);
        setIsTyping(false);
        appendAssistant(
          `❌ Could not reach the Meta-Agent. Ensure it's running:\n\n` +
            "```\ncd agents && uvicorn main:app --reload --port 8000\n```\n\n" +
            `Error: ${msg}`
        );
        setStep("idle");
      } finally {
        setIsGenerating(false);
      }
    },
    [
      appendAssistant,
      buildPayload,
      envDefaults,
      pushHistory,
      walletDisplayAddress,
      walletHexAddress,
    ]
  );

  // ── finalizeBot ───────────────────────────────────────────────────────────

  // eslint-disable-next-line react-hooks/exhaustive-deps
  const finalizeBot = useCallback(
    async (params: {
      files: Record<string, unknown>[];
      intent: Record<string, unknown>;
      botName: string;
      envConfig: Record<string, string>;
    }) => {
      const { files, intent, botName, envConfig } = params;
      setStep("generating");
      setIsTyping(true);

      try {
        await sleep(400);
        setIsTyping(false);
        appendAssistant("⏳ Saving your bot and encrypting credentials…");

        const authHeaders = await getWalletAuthHeaders({ publicKey, signMessage });

        const saveRes = await fetch("/api/generate-bot", {
          method: "POST",
          headers: { "Content-Type": "application/json", ...(authHeaders ?? {}) },
          body: JSON.stringify({
            prompt: chatHistoryRef.current[0]?.content ?? botName,
            expandedPrompt:
              expandedPromptRef.current || chatHistoryRef.current[0]?.content,
            envConfig,
            intent,
            walletAddress: walletHexAddress,
          }),
        });

        if (!saveRes.ok) {
          const errText = await saveRes.text().catch(() => "");
          throw new Error(`Save failed (${saveRes.status}): ${errText.slice(0, 300)}`);
        }

        const saved = await saveRes.json();
        const agentId = String(saved.agentId ?? "");
        if (!agentId) throw new Error("No agentId returned from save endpoint.");

        setGeneratedAgentId(agentId);
        setStep("done");
        setChips([]);

        appendAssistant(
          `🎉 **${botName}** is ready! Generated, verified, and saved.`,
          { type: "success_card", agentId, botName }
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        setIsTyping(false);
        appendAssistant(`❌ Failed to save bot: ${msg}`);
        setStep("idle");
      }
    },
    [appendAssistant, walletHexAddress]
  );

  // ── submitDynamicKeys ─────────────────────────────────────────────────────

  const submitDynamicKeys = useCallback(
    async (formData: Record<string, string>) => {
      if (!pendingBotRef.current) return;
      const { files, intent, botName } = pendingBotRef.current;

      const mergedEnv: Record<string, string> = {
        ...envDefaults,
        ...(walletHexAddress
          ? { USER_WALLET_ADDRESS: walletHexAddress }
          : {}),
        ...formData,
      };

      const contextLine = Object.entries(formData)
        .filter(([k, v]) => k !== "USER_WALLET_ADDRESS" && v.trim())
        .map(([k, v]) => `${k}=${v}`)
        .join(", ");
      if (contextLine) pushHistory("user", `My configuration: ${contextLine}`);

      await finalizeBot({ files, intent, botName, envConfig: mergedEnv });
    },
    [envDefaults, finalizeBot, pushHistory, walletHexAddress]
  );

  // ── Main send handler ─────────────────────────────────────────────────────

  const handleSend = useCallback(
    async (overrideText?: string) => {
      const text = (overrideText ?? input).trim();
      if (!text || isGenerating) return;

      setInput("");
      setChips([]);

      // ── GATE: block backend calls until wallet is connected ─────────────
      if (!isWalletConnected) {
        appendMessage("user", text);
        await sleep(300);
        setIsTyping(true);
        await sleep(600);
        setIsTyping(false);
        appendAssistant(
          "⚠️ **Wallet not connected.**\n\n" +
            "I need your wallet address to configure the bot correctly. " +
            "Please connect your wallet using the Connect button in the header, then send your message again.\n\n" +
            "Once connected, I'll automatically detect your address — you won't need to paste it anywhere."
        );
        return; // ← no API call made
      }

      // Append to UI and persistent history
      appendMessage("user", text);
      pushHistory("user", text);
      setIsTyping(true);

      try {
        const isFirstUserMessage =
          chatHistoryRef.current.filter((m) => m.role === "user").length === 1;

        if (isFirstUserMessage) {
          // Expand the prompt via classify-intent (non-fatal if it fails)
          let expandedPrompt = text;
          try {
            const authHeaders = await getWalletAuthHeaders({ publicKey, signMessage });
            const classifyRes = await fetch("/api/classify-intent", {
              method: "POST",
              headers: { "Content-Type": "application/json", ...(authHeaders ?? {}) },
              body: JSON.stringify({ prompt: text }),
            });
            if (classifyRes.ok) {
              const classifyData = await classifyRes.json();
              expandedPrompt = classifyData.expandedPrompt || text;
              detectedStrategyRef.current = String(
                classifyData.intent?.strategy ?? "custom_utility"
              );
              expandedPromptRef.current = expandedPrompt;
            }
          } catch {
            /* non-fatal */
          }

          setIsTyping(false);
          appendAssistant(
            `Analysing your request with wallet \`${truncateAddr(walletDisplayAddress)}\` — checking on-chain parameters…`
          );
          pushHistory("assistant", "Analysing…");

          await sleep(300);
          await callPlannerAgent();
          return;
        }

        // Subsequent turns: re-run planner with updated history
        setIsTyping(false);
        await callPlannerAgent();
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        setIsTyping(false);
        appendAssistant(`❌ ${msg}`);
        setStep("idle");
      }
    },
    [
      input,
      isGenerating,
      isWalletConnected,
      walletDisplayAddress,
      appendMessage,
      appendAssistant,
      pushHistory,
      callPlannerAgent,
    ]
  );

  const handleKeyDown = useCallback(
    (e: KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        void handleSend();
      }
    },
    [handleSend]
  );

  const handleInputChange = useCallback(
    (e: ChangeEvent<HTMLTextAreaElement>) => setInput(e.target.value),
    []
  );

  return {
    messages,
    input,
    isTyping,
    isGenerating,
    chips,
    bottomRef,
    generatedAgentId,
    step,
    envDefaults,
    // Wallet — useful for UI badges/indicators
    walletAddress,
    isWalletConnected,
    openConnect,
    // Handlers
    handleSend,
    handleKeyDown,
    handleInputChange,
    submitDynamicKeys,
  };
}