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
  formMode?: "clarification" | "final";
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
    {
      key: "MAGICBLOCK_TEE_VALIDATOR",
      label: "MagicBlock TEE Validator",
      placeholder: "mainnet-tee.magicblock.app",
      required: false,
    },
    {
      key: "UMBRA_PROGRAM_ADDRESS",
      label: "Umbra Program Address",
      placeholder: "UMBRAD2ishebJTcgCLkTkNUx1v3GyoAgpTRPeWoLykh",
      required: false,
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
    {
      key: "MAGICBLOCK_TEE_VALIDATOR",
      label: "MagicBlock TEE Validator",
      placeholder: "mainnet-tee.magicblock.app",
      required: false,
    },
    {
      key: "UMBRA_PROGRAM_ADDRESS",
      label: "Umbra Program Address",
      placeholder: "DSuKkyqGVGgo4QtPABfxKJKygUDACbUhirnuv63mEpAJ",
      required: false,
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

function extractUppercaseKeys(text: string): string[] {
  const matches = text.match(/\b[A-Z][A-Z0-9_]{2,}\b/g) ?? [];
  return Array.from(new Set(matches));
}

function normalizeClarificationValue(value: string): string {
  return value.trim().replace(/^['"`]+|['"`]+$/g, "");
}

function parseClarificationReply(
  text: string,
  expectedKeys: string[]
): Record<string, string> {
  const cleaned = text.trim();
  if (!cleaned) return {};

  const explicitPairs: Record<string, string> = {};
  const pairPattern = /\b([A-Z][A-Z0-9_]{2,})\b\s*[:=]\s*([^,;\n]+)/g;
  for (const match of cleaned.matchAll(pairPattern)) {
    const key = match[1];
    const value = normalizeClarificationValue(match[2]);
    if (value) explicitPairs[key] = value;
  }
  if (Object.keys(explicitPairs).length > 0) {
    return explicitPairs;
  }

  const orderedValues = cleaned
    .split(/(?:\s*,\s*|\s+and\s+|\n+)/i)
    .map(normalizeClarificationValue)
    .filter(Boolean);

  if (expectedKeys.length > 0 && orderedValues.length > 0) {
    const mapped: Record<string, string> = {};
    expectedKeys.forEach((key, index) => {
      if (orderedValues[index]) {
        mapped[key] = orderedValues[index];
      }
    });
    return mapped;
  }

  return {};
}

function humanizeKey(key: string): string {
  return key
    .replace(/_/g, " ")
    .toLowerCase()
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

function buildClarificationFields(keys: string[]): CredentialField[] {
  const labels: Record<string, { label: string; placeholder: string; type?: "text" | "password" }> = {
    USER_WALLET_ADDRESS: {
      label: "User Wallet Address (base58 or 0x hex)",
      placeholder: "Wallet address",
    },
    TOKEN_MINT_ADDRESS: {
      label: "Token Mint Address (base58)",
      placeholder: "Mint address",
    },
    MIN_BALANCE_THRESHOLD: {
      label: "Minimum Balance Threshold",
      placeholder: "e.g. 1% or 0.5 SOL",
    },
    YIELD_THRESHOLD: {
      label: "Yield Threshold",
      placeholder: "e.g. 2%",
    },
    SLIPPAGE_LIMIT: {
      label: "Slippage Limit",
      placeholder: "e.g. 5%",
    },
  };

  return keys
    .filter((key) => key !== "USER_WALLET_ADDRESS")
    .map((key) => {
      const preset = labels[key];
      return {
        key,
        label: preset?.label ?? humanizeKey(key),
        placeholder: preset?.placeholder ?? `Enter ${humanizeKey(key)}`,
        type: preset?.type ?? "text",
        required: true,
      };
    });
}

function buildClarificationQuestion(keys: string[]): string {
  const visibleKeys = keys.filter((key) => key !== "USER_WALLET_ADDRESS");
  if (visibleKeys.length === 0) {
    return "Could you provide a bit more detail?";
  }

  if (visibleKeys.length === 1) {
    return `Please provide your ${visibleKeys[0]}.`;
  }

  const lastKey = visibleKeys[visibleKeys.length - 1];
  const head = visibleKeys.slice(0, -1).join(", ");
  return `Please provide your ${head}, and ${lastKey}.`;
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
  const plannerWalletAddress = walletAddress || walletHexAddress;
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
  const pendingClarificationKeysRef = useRef<string[]>([]);
  const pendingStrategyTypeRef = useRef<string>("");
  const collectedClarificationValuesRef = useRef<Record<string, string>>({});

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

      if (plannerWalletAddress) {
        systemMessages.push({
          role: "system",
          content:
            `System Context (injected by frontend, not visible to user): ` +
            `The user's AutoSign wallet address in base58 is "${walletAddress}" and hex is "${walletHexAddress}". ` +
            `This FULLY SATISFIES the USER_WALLET_ADDRESS parameter requirement. ` +
            `Do NOT ask the user for their wallet address under any circumstances — it is confirmed. ` +
            `Treat USER_WALLET_ADDRESS="${plannerWalletAddress}" as already collected and verified.`,
        });
      }

      const clarificationValues = collectedClarificationValuesRef.current;
      if (Object.keys(clarificationValues).length > 0) {
        systemMessages.push({
          role: "system",
          content:
            `Previously clarified configuration values from the user: ` +
            Object.entries(clarificationValues)
              .map(([key, value]) => `${key}=${value}`)
              .join(", ") +
            ". Treat these as already collected.",
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
    [plannerWalletAddress, walletAddress, walletHexAddress]
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
          const rawQuestion = String(data.question ?? "Could you provide more details?");
          const missingParametersRaw = Array.isArray(data.missing_parameters)
            ? data.missing_parameters.map((value: unknown) => String(value))
            : extractUppercaseKeys(rawQuestion);
          if (plannerWalletAddress && missingParametersRaw.includes("USER_WALLET_ADDRESS")) {
            collectedClarificationValuesRef.current = {
              ...collectedClarificationValuesRef.current,
              USER_WALLET_ADDRESS: plannerWalletAddress,
            };
          }
          const missingParameters = missingParametersRaw.filter(
            (key: string) => !(key === "USER_WALLET_ADDRESS" && plannerWalletAddress)
          );
          const question = buildClarificationQuestion(missingParameters);
          pendingClarificationKeysRef.current = missingParameters.length
            ? missingParameters
            : extractUppercaseKeys(question || rawQuestion);
          pendingStrategyTypeRef.current = String(
            data.strategy_type ?? pendingStrategyTypeRef.current ?? detectedStrategyRef.current ?? "custom_utility"
          );
          if (pendingClarificationKeysRef.current.length === 0) {
            await callPlannerAgent(
              `Continue the existing strategy_type=${pendingStrategyTypeRef.current || detectedStrategyRef.current || "custom_utility"}. ` +
                `Treat USER_WALLET_ADDRESS=${plannerWalletAddress} as fixed and do not ask for it again.`
            );
            return;
          }

          setIsTyping(true);
          await sleep(600);
          setIsTyping(false);
          appendAssistant(question, {
            type: "dynamic_credentials_form",
            formMode: "clarification",
            fields: buildClarificationFields(pendingClarificationKeysRef.current),
          });
          pushHistory("assistant", question);
          setStep("ask_keys");
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
            ...(plannerWalletAddress
              ? { USER_WALLET_ADDRESS: plannerWalletAddress }
              : {}),
            ...collectedClarificationValuesRef.current,
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
      plannerWalletAddress,
      walletAddress,
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

        if (!publicKey) {
          throw new Error("Connect your wallet before generating a bot.");
        }

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

        if (!saveRes.body) {
          throw new Error("Streaming response did not include a body.");
        }

        const decoder = new TextDecoder();
        const reader = saveRes.body.getReader();
        let buffer = "";
        let finalPayload: Record<string, unknown> | null = null;
        let clarificationPayload: Record<string, unknown> | null = null;
        const seenStatuses = new Set<string>();

        const emitStatus = (payload: Record<string, unknown>) => {
          const status = String(payload.status ?? "");
          const message = String(payload.message ?? "");
          if (status) {
            if (status === "analyzing_intent" || status === "fetching_context") {
              setStep("planning");
            } else if (status === "generating_code" || status === "validating_syntax" || status === "self_healing") {
              setStep("generating");
            }
            if (message && !seenStatuses.has(status)) {
              seenStatuses.add(status);
              appendAssistant(message);
            }
          }
        };

        const processBuffer = (text: string) => {
          const chunks = text.split(/\r?\n\r?\n/);
          const remainder = chunks.pop() ?? "";
          for (const chunk of chunks) {
            const raw = chunk
              .split(/\r?\n/)
              .filter((line) => line.startsWith("data:"))
              .map((line) => line.slice(5).trimStart())
              .join("\n")
              .trim();
            if (!raw) continue;

            let payload: Record<string, unknown>;
            try {
              payload = JSON.parse(raw) as Record<string, unknown>;
            } catch {
              continue;
            }

            if (payload.error) {
              throw new Error(String(payload.error));
            }

            emitStatus(payload);
            if (payload.status === "clarification_needed") {
              clarificationPayload = payload;
            }
            if (payload.status === "complete") {
              finalPayload = payload;
            }
          }
          return remainder;
        };

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          buffer = processBuffer(buffer);
        }

        buffer += decoder.decode();
        buffer = processBuffer(buffer);

        if (!finalPayload && clarificationPayload) {
          const cp = clarificationPayload as Record<string, unknown>;
          const rawQuestion = String(
            cp["question"] ??
              "I still need a few required parameters before generating this bot."
          );
          const missingParametersRaw = Array.isArray(cp["missing_parameters"])
            ? (cp["missing_parameters"] as unknown[]).map((value: unknown) => String(value))
            : extractUppercaseKeys(rawQuestion);

          if (plannerWalletAddress && missingParametersRaw.includes("USER_WALLET_ADDRESS")) {
            collectedClarificationValuesRef.current = {
              ...collectedClarificationValuesRef.current,
              USER_WALLET_ADDRESS: plannerWalletAddress,
            };
          }

          const missingParameters = missingParametersRaw.filter(
            (key: string) => !(key === "USER_WALLET_ADDRESS" && plannerWalletAddress)
          );

          const question = buildClarificationQuestion(missingParameters);

          pendingClarificationKeysRef.current = missingParameters;
          pendingStrategyTypeRef.current = String(
            cp["strategy_type"] ??
              pendingStrategyTypeRef.current ??
              detectedStrategyRef.current ??
              "custom_utility"
          );

          pendingBotRef.current = { files, intent, botName };

          appendAssistant(question, {
            type: "dynamic_credentials_form",
            formMode: "clarification",
            fields: buildClarificationFields(missingParameters),
          });
          setStep("ask_keys");
          return;
        }

        if (!finalPayload) {
          throw new Error("Stream ended without a final payload.");
        }

        const completedPayload = finalPayload as Record<string, unknown>;
        const agentId = String(completedPayload.agentId ?? "");
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
    [appendAssistant, plannerWalletAddress, publicKey, signMessage, walletHexAddress]
  );

  // ── submitDynamicKeys ─────────────────────────────────────────────────────

  const submitDynamicKeys = useCallback(
    async (formData: Record<string, string>) => {
      if (!pendingBotRef.current) return;
      const { files, intent, botName } = pendingBotRef.current;

      const mergedEnv: Record<string, string> = {
        ...envDefaults,
        ...(plannerWalletAddress
          ? { USER_WALLET_ADDRESS: plannerWalletAddress }
          : {}),
        ...collectedClarificationValuesRef.current,
        ...formData,
      };

      const contextLine = Object.entries(formData)
        .filter(([k, v]) => k !== "USER_WALLET_ADDRESS" && v.trim())
        .map(([k, v]) => `${k}=${v}`)
        .join(", ");
      if (contextLine) pushHistory("user", `My configuration: ${contextLine}`);

      await finalizeBot({ files, intent, botName, envConfig: mergedEnv });
    },
    [envDefaults, finalizeBot, plannerWalletAddress, pushHistory]
  );

  const submitClarificationKeys = useCallback(
    async (formData: Record<string, string>) => {
      const cleaned: Record<string, string> = {};
      for (const [key, value] of Object.entries(formData)) {
        const trimmed = value.trim();
        if (trimmed) cleaned[key] = trimmed;
      }

      if (Object.keys(cleaned).length === 0) return;

      collectedClarificationValuesRef.current = {
        ...collectedClarificationValuesRef.current,
        ...cleaned,
      };

      const contextLine = Object.entries(cleaned)
        .map(([key, value]) => `${key}=${value}`)
        .join(", ");

      if (contextLine) {
        pushHistory("user", `Clarification values: ${contextLine}`);
      }

      if (!pendingBotRef.current) {
        await callPlannerAgent(
          `Continue the existing strategy_type=${pendingStrategyTypeRef.current || detectedStrategyRef.current || "custom_utility"}. ` +
            `Do not change strategy_type. Treat these collected parameters as fixed: ${contextLine}.`
        );
        return;
      }

      const mergedEnv: Record<string, string> = {
        ...envDefaults,
        ...(plannerWalletAddress ? { USER_WALLET_ADDRESS: plannerWalletAddress } : {}),
        ...collectedClarificationValuesRef.current,
      };

      const { files, intent, botName } = pendingBotRef.current;
      const requiredFields = buildClarificationFields(pendingClarificationKeysRef.current);
      const missingAfterSubmit = requiredFields.some((field) => !mergedEnv[field.key]?.trim());
      if (missingAfterSubmit) {
        await callPlannerAgent(
          `Continue the existing strategy_type=${pendingStrategyTypeRef.current || detectedStrategyRef.current || "custom_utility"}. ` +
            `Do not change strategy_type. Treat these collected parameters as fixed: ${contextLine}.`
        );
        return;
      }

      await finalizeBot({ files, intent, botName, envConfig: mergedEnv });
    },
    [callPlannerAgent, detectedStrategyRef, envDefaults, finalizeBot, pendingBotRef, plannerWalletAddress, pushHistory]
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

      const clarificationReply = parseClarificationReply(
        text,
        pendingClarificationKeysRef.current
      );
      if (Object.keys(clarificationReply).length > 0) {
        collectedClarificationValuesRef.current = {
          ...collectedClarificationValuesRef.current,
          ...clarificationReply,
        };
      }

      try {
        const isFirstUserMessage =
          chatHistoryRef.current.filter((m) => m.role === "user").length === 1;

        const clarificationContext =
          Object.keys(clarificationReply).length > 0
            ? `User supplied clarification values: ${Object.entries(clarificationReply)
                .map(([key, value]) => `${key}=${value}`)
                .join(", ")}.`
            : undefined;

        if (isFirstUserMessage) {
          // Expand the prompt via classify-intent (non-fatal if it fails)
          let expandedPrompt = text;
          pendingClarificationKeysRef.current = [];
          pendingStrategyTypeRef.current = String(detectedStrategyRef.current ?? "custom_utility");
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
          await callPlannerAgent(clarificationContext);
          return;
        }

        // Subsequent turns: re-run planner with updated history
        setIsTyping(false);
        await callPlannerAgent(clarificationContext);
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
    submitClarificationKeys,
  };
}