"use client";

/**
 * frontend/hooks/use-bot-code-gen.ts
 *
 * Fetches bot files — either a specific agentId or the latest bot.
 * Now also extracts and returns the `intent` object stored in the agent's
 * configuration so the UI can render the correct env fields and badges.
 */

import { useState } from "react";
import type { MutableRefObject } from "react";
import type { BotEnvConfig, BotIntent } from "@/lib/bot-constant";
import { DEFAULT_BOT_ENV_CONFIG } from "@/lib/bot-constant";
import { useUser } from "@/lib/user-context";
import { getWalletAuthHeaders } from "@/lib/auth/client";

type TerminalLike = {
  clear: () => void;
  writeln: (line: string) => void;
};

export interface BotFile {
  filepath: string;
  content:  string;
  language?: string;
}

/** Parse a .env file string into a key→value map. */
function parseEnvFile(envContent: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const rawLine of envContent.split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eqIdx = line.indexOf("=");
    if (eqIdx === -1) continue;
    const key   = line.slice(0, eqIdx).trim();
    const value = line.slice(eqIdx + 1).trim();
    if (key) result[key] = value;
  }
  return result;
}

async function loadSharedEnvDefaults(): Promise<Record<string, string>> {
  try {
    const res = await fetch('/api/env-defaults');
    if (!res.ok) return {};
    const data = await res.json().catch(() => ({}));
    if (data && typeof data.values === 'object' && data.values) {
      return data.values as Record<string, string>;
    }
  } catch {
    // Ignore and fall back to the DB/env record.
  }
  return {};
}

function normalizeGatewayUrl(value: string | undefined, fallback: string): string {
  const current = String(value ?? '').trim();
  if (!current) return fallback;
  if (/^https?:\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0|192\.168\.)/i.test(current)) {
    return fallback || (typeof window !== 'undefined' ? `${window.location.origin}/api/mcp-proxy` : current);
  }
  if (/^\/api\/mcp-proxy\/?/i.test(current)) {
    return fallback || (typeof window !== 'undefined' ? `${window.location.origin}/api/mcp-proxy` : current);
  }
  return current;
}

/** Extract BotIntent from whatever shape the DB stores it in. */
function extractIntent(config: Record<string, unknown> | null | undefined): BotIntent | null {
  if (!config) return null;

  // The orchestrator stores it under `intent`
  if (config.intent && typeof config.intent === "object") {
    const raw = config.intent as Record<string, unknown>;
    const mcps = [
      ...(Array.isArray(raw.mcps) ? raw.mcps : []),
      ...(Array.isArray(raw.required_mcps) ? raw.required_mcps : []),
    ].map((m) => String(m || "").trim()).filter(Boolean);

    return {
      chain: "solana",
      network: typeof raw.network === "string" ? raw.network : undefined,
      strategy: typeof raw.strategy === "string" ? raw.strategy : undefined,
      execution_model: typeof raw.execution_model === "string"
        ? raw.execution_model as BotIntent["execution_model"]
        : "polling",
      mcps,
      required_mcps: mcps,
      bot_name: typeof raw.bot_name === "string" ? raw.bot_name : undefined,
      bot_type: typeof raw.bot_type === "string" ? raw.bot_type : undefined,
      requires_openai: Boolean(raw.requires_openai ?? raw.requires_openai_key),
      requires_openai_key: Boolean(raw.requires_openai ?? raw.requires_openai_key),
    };
  }

  // Fallback: reconstruct a minimal intent from flat config fields
  const chain = "solana";
  const network = typeof config.network === "string" ? config.network : "solana-testnet";

  if (config.strategy || config.chain) {
    return {
      chain,
      network,
      strategy:        typeof config.strategy === "string" ? config.strategy : undefined,
      execution_model: typeof config.execution_model === "string" ? config.execution_model as BotIntent["execution_model"] : "polling",
      required_mcps:   Array.isArray(config.required_mcps) ? config.required_mcps as string[] : [],
      mcps:            Array.isArray(config.mcps) ? config.mcps as string[] : [],
      bot_name:        typeof config.bot_name === "string" ? config.bot_name : undefined,
      bot_type:        typeof config.bot_type === "string" ? config.bot_type : undefined,
      requires_openai: Boolean(config.requires_openai ?? config.requires_openai_key),
      requires_openai_key:    Boolean(config.requires_openai_key),
    };
  }

  return null;
}

export function useBotCodeGen(termRef: MutableRefObject<TerminalLike | null>) {
  const { walletSigner } = useUser();
  const [generatedFiles, setGeneratedFiles] = useState<BotFile[]>([]);
  const [selectedFile,   setSelectedFile]   = useState<string | null>(null);
  const [agentId,        setAgentId]        = useState<string | null>(null);
  const [botName,        setBotName]        = useState<string>("ArbitrageBot");
  const [intent,         setIntent]         = useState<BotIntent | null>(null);

  const generateFiles = async (specificAgentId?: string) => {
    const term = termRef.current;
    if (!term) return null;
    term.clear();
    term.writeln("\x1b[36m[System]\x1b[0m Loading bot files…");

    try {
      // ── Try DB first ───────────────────────────────────────────────────
      const url = specificAgentId
        ? `/api/get-latest-bot?agentId=${specificAgentId}`
        : `/api/get-latest-bot`;

      const authHeaders = await getWalletAuthHeaders(walletSigner);
      const dbRes = await fetch(url, {
        headers: {
          ...(authHeaders ?? {}),
        },
      });

      if (dbRes.ok) {
        const data: {
          agentId:  string;
          name:     string;
          files:    BotFile[];
          walletAddress?: string;
          config?:  Record<string, unknown>;
        } = await dbRes.json();

        if (data.files?.length) {
          setGeneratedFiles(data.files);

          // Default to index.ts or main.py (not .env)
          const mainFile = data.files.find(f =>
            f.filepath === "src/index.ts" ||
            f.filepath === "src/index.js" ||
            f.filepath === "main.py"
          );
          setSelectedFile(mainFile?.filepath ?? data.files[0]?.filepath ?? null);

          if (data.agentId) setAgentId(data.agentId);
          if (data.name)    setBotName(data.name);

          // ── Extract intent ───────────────────────────────────────────
          const detectedIntent = extractIntent(data.config ?? null);
          if (detectedIntent) {
            setIntent(detectedIntent);
            term.writeln(
              `\x1b[36m[System]\x1b[0m Intent: \x1b[32m${detectedIntent.strategy ?? "unknown"}\x1b[0m` +
              ` on \x1b[32m${detectedIntent.network ?? detectedIntent.chain ?? "solana-testnet"}\x1b[0m`
            );
          }

          // ── Parse .env file ──────────────────────────────────────────
          const envFile = data.files.find(f => f.filepath === ".env");
          let loadedEnvConfig: BotEnvConfig | null = null;

          if (envFile?.content) {
            const parsed = parseEnvFile(envFile.content);
            const sharedDefaults = await loadSharedEnvDefaults();
            const publicGateway = normalizeGatewayUrl(
              parsed.MCP_GATEWAY_URL,
              sharedDefaults.MCP_GATEWAY_URL ?? DEFAULT_BOT_ENV_CONFIG.MCP_GATEWAY_URL,
            );
            loadedEnvConfig = {
              ...DEFAULT_BOT_ENV_CONFIG,
              ...parsed,
              MCP_GATEWAY_URL: publicGateway,
            };

            const foundKeys = Object.entries(loadedEnvConfig)
              .filter(([, v]) => v && v !== "true" && v !== "1" && v !== "5" && !v.startsWith("http://localhost"))
              .map(([k]) => k);

            term.writeln(
              `\x1b[36m[System]\x1b[0m .env loaded — keys: \x1b[32m${foundKeys.join(", ") || "none"}\x1b[0m`
            );
          } else {
            term.writeln("\x1b[33m[System]\x1b[0m No .env in DB — please fill in credentials.");
          }

          term.writeln(
            `\x1b[32m[System]\x1b[0m Loaded \x1b[1m${data.name || "bot"}\x1b[0m (${data.files.length} files)`
          );

          return { success: true, loadedEnvConfig, intent: detectedIntent };
        }
      }

      // ── Fallback: hardcoded demo bot ────────────────────────────────────
      term.writeln("\x1b[33m[System]\x1b[0m No custom bot found — loading demo bot…");
      const res = await fetch("/api/get-bot-code", {
        method:  "POST",
        headers: { "Content-Type": "application/json", ...(authHeaders ?? {}) },
        body:    JSON.stringify({}),
      });

      if (!res.ok) throw new Error(`HTTP ${res.status}: ${res.statusText}`);

      const data: { thoughts: string; files: BotFile[]; agentId?: string } = await res.json();
      if (!data.files?.length) throw new Error("No files received");

      setGeneratedFiles(data.files);
      setSelectedFile("src/index.ts");
      if (data.agentId) setAgentId(data.agentId);

      // Demo bot is always Solana
      const demoIntent: BotIntent = {
        chain: "solana", network: "solana-testnet",
        strategy: "arbitrage", execution_model: "polling",
        required_mcps: ["solana"],
        bot_type: "Solana Bot",
        requires_openai_key: false,
      };
      setIntent(demoIntent);

      term.writeln(`\x1b[32m[System]\x1b[0m ${data.files.length} demo files loaded.`);
      term.writeln(`\x1b[33m[Bot]\x1b[0m ${data.thoughts}`);

      return { success: true, loadedEnvConfig: null, intent: demoIntent };

    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      term.writeln(`\x1b[31m[Error]\x1b[0m ${msg}`);
      return { success: false, loadedEnvConfig: null, intent: null };
    }
  };

  return {
    generateFiles,
    generatedFiles,
    selectedFile,
    setSelectedFile,
    agentId,
    botName,
    intent,
  };
}