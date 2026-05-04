import { NextRequest, NextResponse } from "next/server";
import { sanitizeIntentMcpLists } from "@/lib/intent/mcp-sanitizer";

const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const GITHUB_MODEL_ENDPOINT = process.env.GITHUB_MODEL_ENDPOINT || "https://models.inference.ai.azure.com";
const MODEL_URL = GITHUB_MODEL_ENDPOINT.replace(/\/+$/, "") + "/chat/completions";
const MAX_INPUT_TOKENS = Number(process.env.MAX_INPUT_TOKENS ?? "8000");
const APPROX_CHARS_PER_TOKEN = Number(process.env.APPROX_CHARS_PER_TOKEN ?? "4");
const RESERVED_INPUT_CHARS = Number(process.env.RESERVED_INPUT_CHARS ?? "1200");

// ─── Rich Expander System Prompt ─────────────────────────────────────────────
// This prompt produces a deeply detailed technical spec so the downstream
// code-generation agent has maximum context about what to build.

const EXPANDER_SYSTEM_PROMPT = `You are an expert Solana Blockchain Architect and senior backend engineer.

Your task: take a brief user idea for a Solana-native bot and expand it into an exhaustive, production-grade technical specification. The output will be fed directly to a code-generation agent.

Cover ALL of the following in your expansion:

1. **Target & Execution Architecture**:
  - Chain: Solana (mainnet-beta fork).
  - Execution Model: Polling loop, Event-driven, or Agentic (AI-driven). Define the exact triggers or intervals.

2. **Domain-Specific Logic (Adapt to the user's request)**:
  - *If Arbitrage/DeFi:* Define flash loan accounting, slippage limits, specific routing pools, and profit math.
  - *If Yield/Sweeper:* Define balance threshold checks and bridge execution parameters.
  - *If NFT/Social/Other:* Define the specific program addresses, queries, and execution rules required.

3. **Solana MCP Integration Guide (CRITICAL)**:
  - The bot MUST use the local \`solana_utils.ts\` file to interact with Solana.
  - **Reads/Writes:** Use Solana SDK and MCP endpoints for all blockchain interactions.

4. **Token Balance Rule (CRITICAL)**:
  - Solana uses SPL tokens. Use the provided helpers to check balances and send transactions.
  - **Example:**
    \`\`\`typescript
    import { getSolBalance } from "./solana_utils";
    const balance = await getSolBalance(network, walletAddress);
    \`\`\`

5. **TypeScript Implementation Constraints**:
  - Use standard \`BigInt\` for all on-chain amounts. No floats.
  - Entry point is always \`src/index.ts\`.
  - **CRITICAL CONFIG RULE:** DO NOT generate a separate \`config.ts\` file. Read all variables directly from \`process.env\`.
  - **CRITICAL TS RULE:** To satisfy TypeScript without crashing, ALWAYS wrap \`process.env\` variables in \`String(...)\`.
    WRONG: \`if (!process.env.WALLET) process.exit(1);\`
    RIGHT: \`const wallet = String(process.env.USER_WALLET_ADDRESS ?? "");\`

Output ONLY the expanded technical specification in plain text with clear headers. No preamble. Be highly specific about the Solana programs and functions needed based on the user's intent.`;

// ─── Fallback intent classifier (runs entirely in Next.js if Python is down) ──

const FALLBACK_CLASSIFIER_PROMPT = `You are a DeFi bot intent classifier. Analyze the user's trading bot request and output ONLY a valid JSON object — no markdown, no preamble.

Required schema:
{
  "chain": "solana",
  "network": "mainnet-beta",
  "execution_model": "polling" | "websocket" | "agentic",
  "strategy": "arbitrage" | "sniping" | "dca" | "grid" | "sentiment" | "whale_mirror" | "news_reactive" | "yield" | "yield_sweeper" | "cross_chain_liquidation" | "cross_chain_arbitrage" | "cross_chain_sweep" | "custom_utility" | "perp" | "mev_intent" | "scalper" | "rebalancing" | "ta_scripter" | "unknown",
  "required_mcps": ["solana"],
  "bot_type": "human-readable bot name",
  "requires_openai_key": true | false
}

Classification rules (first match wins):
- ALWAYS return chain:"solana" for every request unless the prompt explicitly requests Solana/Move behavior.
- if request includes cross-rollup yield sweeper semantics (yield sweeper, auto-consolidator, consolidate idle funds, bridge back to l1, sweep_to_l1), classify as strategy:"yield" with required_mcps:["solana"] and bot_type:"Cross-Rollup Yield Sweeper".
- cross-chain liquidation / liquidation sniper / omni-chain liquidator → strategy:"cross_chain_liquidation", required_mcps:["solana"]
- flash-bridge arbitrage / cross-chain arb / spatial arbitrage → strategy:"cross_chain_arbitrage", required_mcps:["solana"]
- omni-chain yield / yield nomad / auto-compounder → strategy:"cross_chain_sweep", required_mcps:["solana"]
- if request asks for a custom utility bot, classify as strategy:"custom_utility" with required_mcps:["solana"] and bot_type:"Custom Utility Solana Bot".
- sentiment | social → execution_model:"agentic", strategy:"sentiment", required_mcps:["solana"], requires_openai_key:true
- yield sweeper | auto-consolidator | consolidate idle funds → execution_model:"polling", strategy:"yield", required_mcps:["solana"]
- spread scanner | read-only arbitrage | market intelligence scanner → execution_model:"polling", strategy:"arbitrage", required_mcps:["solana"]
- flash loan | arbitrage | hot potato → execution_model:"polling", strategy:"arbitrage", required_mcps:["solana"]
- otherwise default execution_model:"polling", strategy:"unknown", required_mcps:["solana"]
- if chain is solana, allow only these MCPs: solana (required)
- default network if unspecified → "mainnet-beta"`;

function normalizeIntentFromPrompt(intent: Record<string, unknown>, prompt: string): Record<string, unknown> {
  const mergedPrompt = String(prompt ?? "").toLowerCase();
  const isCrossChainLiquidation = /(liquidation sniper|omni-chain liquidat|cross[-. ]chain liquidat)/.test(mergedPrompt);
  const isCrossChainArbitrage = /(flash[-. ]bridge|spatial arb|cross[-. ]chain arb)/.test(mergedPrompt);
  const isCrossChainSweep = /(yield nomad|auto[-. ]compounder|omni[-. ]chain yield)/.test(mergedPrompt);
  const isYieldSweeper = /(yield sweeper|auto-consolidator|auto consolidator|consolidate idle funds|sweep_to_l1|bridge back to l1)/.test(mergedPrompt);
  const isSpreadScanner = /(spread scanner|read-only scanner|read only scanner|market intelligence)/.test(mergedPrompt);
  const isSentiment = /(sentiment|social)/.test(mergedPrompt);
  const isCustomUtility = /(custom utility|custom bot|custom workflow|intent:\s*custom|strategy:\s*custom)/.test(mergedPrompt);

  const normalized: Record<string, unknown> = {
    ...intent,
    chain: "solana",
    network: "mainnet-beta",
  };


  if (isCustomUtility) {
    normalized.execution_model = "polling";
    normalized.strategy = "custom_utility";
    normalized.bot_type = "Custom Utility Solana Bot";
    normalized.bot_name = "Custom Utility Solana Bot";
    normalized.required_mcps = ["solana"];
    normalized.mcps = ["solana"];
    normalized.requires_openai_key = false;
    normalized.requires_openai = false;
    return normalized;
  }

  if (isCrossChainLiquidation) {
    normalized.execution_model = "polling";
    normalized.strategy = "cross_chain_liquidation";
    normalized.bot_type = "Omni-Chain Liquidation Sniper";
    normalized.bot_name = "Omni-Chain Liquidation Sniper";
    normalized.required_mcps = ["solana"];
    normalized.mcps = ["solana"];
    normalized.requires_openai_key = false;
    normalized.requires_openai = false;
    return normalized;
  }

  if (isCrossChainArbitrage) {
    normalized.execution_model = "polling";
    normalized.strategy = "cross_chain_arbitrage";
    normalized.bot_type = "Flash-Bridge Spatial Arbitrageur";
    normalized.bot_name = "Flash-Bridge Spatial Arbitrageur";
    normalized.required_mcps = ["solana"];
    normalized.mcps = ["solana"];
    normalized.requires_openai_key = false;
    normalized.requires_openai = false;
    return normalized;
  }

  if (isCrossChainSweep) {
    normalized.execution_model = "polling";
    normalized.strategy = "cross_chain_sweep";
    normalized.bot_type = "Omni-Chain Yield Nomad";
    normalized.bot_name = "Omni-Chain Yield Nomad";
    normalized.required_mcps = ["solana"];
    normalized.mcps = ["solana"];
    normalized.requires_openai_key = false;
    normalized.requires_openai = false;
    return normalized;
  }

  if (isYieldSweeper) {
    normalized.execution_model = "polling";
    normalized.strategy = "yield";
    normalized.bot_type = "Cross-Chain Yield Sweeper";
    normalized.bot_name = "Cross-Chain Yield Sweeper";
    normalized.required_mcps = ["solana"];
    normalized.mcps = ["solana"];
    normalized.requires_openai_key = false;
    normalized.requires_openai = false;
    return normalized;
  }

  if (isSpreadScanner) {
    normalized.execution_model = "polling";
    normalized.strategy = "arbitrage";
    normalized.bot_type = "Cross-Chain Spread Scanner";
    normalized.bot_name = "Cross-Chain Spread Scanner";
    normalized.required_mcps = ["solana"];
    normalized.mcps = ["solana"];
    normalized.requires_openai_key = false;
    normalized.requires_openai = false;
    return normalized;
  }

  if (isSentiment) {
    normalized.execution_model = "agentic";
    normalized.strategy = "sentiment";
    normalized.required_mcps = ["solana"];
    normalized.mcps = ["solana"];
    normalized.requires_openai_key = true;
    normalized.requires_openai = true;
    return normalized;
  }

  return normalized;
}

function truncateWithMarker(input: string, maxChars: number): string {
  if (input.length <= maxChars) return input;
  const head = Math.floor(maxChars * 0.7);
  const tail = Math.max(300, maxChars - head - 64);
  return `${input.slice(0, head)}\n\n[...truncated for model limit...]\n\n${input.slice(-tail)}`;
}

// ─── Helper: call GitHub Models with a short timeout ─────────────────────────

async function callGitHubModels(
  model: string,
  systemPrompt: string,
  userContent: string,
  maxTokens: number,
  temperature: number,
  timeoutMs: number
): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(MODEL_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${GITHUB_TOKEN}`,
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user",   content: userContent },
        ],
        temperature,
        max_tokens: maxTokens,
      }),
      signal: controller.signal,
    });

    console.log(
      "[classify-intent] GitHub Models response:",
      JSON.stringify({ model, status: res.status, ok: res.ok })
    );

    if (!res.ok) {
      const errText = await res.text().catch(() => "");
      throw new Error(`GitHub Models ${res.status}: ${errText.slice(0, 200)}`);
    }

    const data = await res.json();

    // Normalize multiple possible response shapes from model providers.
    const extract = (obj: any): string => {
      try {
        if (!obj) return "";
        // OpenAI/GitHub-like: { choices: [ { message: { content: "..." } } ] }
        if (obj.choices && Array.isArray(obj.choices) && obj.choices.length > 0) {
          const first = obj.choices[0];
          if (first?.message && typeof first.message.content === "string") return first.message.content.trim();
          if (typeof first.text === "string") return first.text.trim();
          if (first?.delta && typeof first.delta.content === "string") return first.delta.content.trim();
        }
        // Some providers use an "output" shape: { output: [ { content: [ { text: "..." } ] } ] }
        if (Array.isArray(obj.output) && obj.output.length > 0) {
          const out = obj.output[0];
          if (out && Array.isArray(out.content) && out.content.length > 0 && typeof out.content[0].text === "string") {
            return out.content[0].text.trim();
          }
          if (out && typeof out.text === "string") return out.text.trim();
        }
        // Fallbacks
        if (obj.message && typeof obj.message === "string") return obj.message.trim();
        if (typeof obj === "string") return obj.trim();
        return JSON.stringify(obj);
      } catch (e) {
        return String(obj ?? "");
      }
    };

    return extract(data);
  } finally {
    clearTimeout(timer);
  }
}

// ─── Route handler ────────────────────────────────────────────────────────────

export async function POST(req: NextRequest) {
  console.log("[classify-intent] Received request");

  try {
    const body = await req.json();
    const originalPrompt: string = body.prompt;

    if (!originalPrompt?.trim()) {
      return NextResponse.json({ error: "Prompt is required." }, { status: 400 });
    }

    console.log("[classify-intent] Original prompt:", originalPrompt);

    // ── Step 1: Expand the prompt into a rich technical spec ────────────────
    let expandedPrompt = originalPrompt;

    if (GITHUB_TOKEN) {
      try {
        console.log("[classify-intent] Expanding prompt via gpt-4o-mini...");
        expandedPrompt = await callGitHubModels(
          "gpt-4o-mini",
          EXPANDER_SYSTEM_PROMPT,
          `Expand this bot idea into a full technical specification:\n\n${originalPrompt}`,
          1200,   // max_tokens — enough for a thorough spec
          0.5,
          25_000  // 25 second timeout for expansion
        );
        console.log("[classify-intent] Expanded prompt length:", expandedPrompt.length, "chars");
        console.log("[classify-intent] Expanded prompt preview:\n", expandedPrompt.slice(0, 300), "...");
      } catch (expandErr: unknown) {
        const msg = expandErr instanceof Error ? expandErr.message : String(expandErr);
        console.warn("[classify-intent] Prompt expansion failed, using original:", msg);
        expandedPrompt = originalPrompt;
      }
    } else {
      console.warn("[classify-intent] No GITHUB_TOKEN — skipping expansion.");
    }

    // Keep expanded specs concise so downstream generation stays within model limits.
    const approxBudgetChars = Math.max(
      600,
      Math.floor(MAX_INPUT_TOKENS * APPROX_CHARS_PER_TOKEN - RESERVED_INPUT_CHARS),
    );
    const MAX_EXPANDED_PROMPT_CHARS = Math.min(
      Number(process.env.MAX_EXPANDED_PROMPT_CHARS ?? "3200"),
      approxBudgetChars,
    );
    if (expandedPrompt.length > MAX_EXPANDED_PROMPT_CHARS) {
      console.warn(
        "[classify-intent] Expanded prompt too long; truncating:",
        expandedPrompt.length,
        "->",
        MAX_EXPANDED_PROMPT_CHARS,
      );
      expandedPrompt = truncateWithMarker(expandedPrompt, MAX_EXPANDED_PROMPT_CHARS);
    }

    // ── Step 2: Classify intent locally via LLM fallback classifier ──────────
    // The updated Python Meta-Agent now exposes /create-bot (not /classify-intent),
    // so this route classifies intent in-process to keep generation flow fast.
    let intent: Record<string, unknown> | null = null;

    // ── Step 3: Classify directly via GitHub Models
    if (!intent || typeof intent !== "object") {
      if (GITHUB_TOKEN) {
        try {
          console.log("[classify-intent] Running fallback LLM classifier...");
          const raw = await callGitHubModels(
            "gpt-4o-mini",
            FALLBACK_CLASSIFIER_PROMPT,
            expandedPrompt,
            512,
            0.0,
            15_000 // 15 second timeout
          );

          // Strip markdown fences if present
          let cleaned = raw.trim();
          if (cleaned.startsWith("```")) {
            const parts = cleaned.split("```");
            cleaned = parts[1] ?? cleaned;
            if (cleaned.startsWith("json")) cleaned = cleaned.slice(4);
          }
          cleaned = cleaned.trim();

          const parsed = JSON.parse(cleaned);
          intent = Array.isArray(parsed) ? parsed[0] : parsed;
          console.log("[classify-intent] Fallback classification succeeded:", JSON.stringify(intent));
        } catch (fallbackErr: unknown) {
          const msg = fallbackErr instanceof Error ? fallbackErr.message : String(fallbackErr);
          console.warn("[classify-intent] Fallback classifier also failed:", msg);
        }
      }
    }

    // ── Step 4: Last-resort default intent ──────────────────────────────────
    if (!intent || typeof intent !== "object") {
      console.warn("[classify-intent] All classification attempts failed — using hardcoded default.");
      intent = deriveDefaultIntent(expandedPrompt);
    }

    const normalizedIntent = normalizeIntentFromPrompt(
      intent as Record<string, unknown>,
      `${originalPrompt}\n${expandedPrompt}`,
    );

    // If the user explicitly references Solana in the prompt, prefer Solana
    // as the target chain so downstream flows (generation, templates) are
    // Solana-first for Solana-specific requests.
    const combinedPrompt = `${originalPrompt}\n${expandedPrompt}`;
    if (/\bsolana\b/i.test(combinedPrompt)) {
      normalizedIntent.chain = "solana";
    }

    const sanitizedIntent = sanitizeIntentMcpLists(normalizedIntent);
    console.log("[classify-intent] Final intent:", JSON.stringify(sanitizedIntent));

    return NextResponse.json({
      intent: sanitizedIntent,
      expandedPrompt,
    });

  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[classify-intent] Unhandled error:", msg);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}

// ─── Derive a sensible default intent from the raw prompt text ────────────────

function deriveDefaultIntent(prompt: string): Record<string, unknown> {
  const lower = prompt.toLowerCase();
  const isCrossChainLiquidation = /(liquidation sniper|omni-chain liquidat|cross[-. ]chain liquidat)/.test(lower);
  const isCrossChainArbitrage = /(flash[-. ]bridge|spatial arb|cross[-. ]chain arb)/.test(lower);
  const isCrossChainSweep = /(yield nomad|auto[-. ]compounder|omni[-. ]chain yield)/.test(lower);
  const isYieldSweeper = /(yield sweeper|auto-consolidator|auto consolidator|consolidate|sweep_to_l1|bridge back to l1|consolidate idle funds)/.test(lower);
  const isSpreadScanner = /(spread scanner|read-only scanner|read only scanner|market intelligence)/.test(lower);
  const isSentiment = lower.includes("sentiment") || lower.includes("social");
  const isCustomUtility = /(custom utility|custom bot|custom workflow|intent:\s*custom|strategy:\s*custom)/.test(lower);
  const solanaNetwork = "mainnet-beta";
  let strategy = "unknown";
  let botName = "Solana Bot";
  
  if (isSentiment) {
    strategy = "sentiment";
    botName = "Solana Sentiment Bot";
  } else if (isCrossChainLiquidation) {
    strategy = "cross_chain_liquidation";
    botName = "Omni-Chain Liquidation Sniper";
  } else if (isCrossChainArbitrage) {
    strategy = "cross_chain_arbitrage";
    botName = "Flash-Bridge Spatial Arbitrageur";
  } else if (isCrossChainSweep) {
    strategy = "cross_chain_sweep";
    botName = "Omni-Chain Yield Nomad";
  } else if (isYieldSweeper) {
    strategy = "yield";
    botName = "Cross-Rollup Yield Sweeper";
  } else if (isCustomUtility) {
    strategy = "custom_utility";
    botName = "Custom Utility Solana Bot";
  } else if (isSpreadScanner || lower.includes("arbitrage") || lower.includes("flash loan")) {
    strategy = "arbitrage";
    botName = "Cross-Rollup Spread Scanner";
  }
  return {
    chain: "solana", network: solanaNetwork,
    execution_model: isSentiment ? "agentic" : "polling",
    strategy,
    required_mcps: ["solana"],
    mcps: ["solana"],
    bot_type: botName,
    bot_name: botName,
    requires_openai: isSentiment,
    requires_openai_key: isSentiment,
  };
}