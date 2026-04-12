"use client";

/**
 * frontend/components/webcontainer-bot-runner.tsx
 *
 * Bot IDE component. Loads bot files from DB, runs them in a WebContainer.
 *
 * Transaction signing architecture:
 *   - move_view  -> goes through MCP gateway directly (read-only, no key needed)
 *   - move_execute -> routed through /api/signing-relay
 *                    SigningRelayConsumer picks it up and calls submitTxBlock
 *                    using the AutoSign Ghost Wallet (no private key exposure)
 */

import { useState, useCallback, useEffect, useRef } from "react";
import { Zap, Play, Square, Bot, ShieldCheck, ShieldOff } from "lucide-react";
import { useWallet } from '@solana/wallet-adapter-react'

import { useTerminal } from "@/hooks/use-terminal";
import { useBotCodeGen } from "@/hooks/use-bot-code-gen";
import { useBotSandbox } from "@/hooks/use-bot-sandbox";
import { FileExplorer } from "@/components/ui/FileExplorer";
import { CodeEditor } from "@/components/ui/code-editor";
import { TerminalPanel } from "@/components/ui/TerminalPanel";
import { SigningRelayConsumer } from "@/components/signing-relay-consumer";
import type { BotEnvConfig, BotIntent } from "@/lib/bot-constant";
import { DEFAULT_BOT_ENV_CONFIG } from "@/lib/bot-constant";

// ── Helpers ───────────────────────────────────────────────────────────────────

function isLocalOrProxy(value?: string | null): boolean {
  const v = String(value || "").trim();
  return (
    /(^|\/\/)(localhost|127\.0\.0\.1|0\.0\.0\.0|192\.168\.)/i.test(v) ||
    /\/api\/mcp-proxy\/?$/i.test(v)
  );
}

function getBrowserProxyGateway(): string {
  if (typeof window === "undefined") return "";
  return `${window.location.origin}/api/mcp-proxy`;
}

function getRuntimeRelayBase(current?: string | null): string {
  if (typeof window === "undefined") return String(current || "").trim();
  const origin = String(window.location.origin || "").trim();
  // Inside WebContainer, localhost points to the sandbox, not the host app.
  if (!origin || /(^|\/\/)(localhost|127\.0\.0\.1|0\.0\.0\.0)(:\d+)?$/i.test(origin)) {
    return String(current || "").trim();
  }
  return origin;
}

function pickReachableGateway(...candidates: Array<string | null | undefined>): string {
  const cleaned = candidates.map((v) => String(v || "").trim()).filter(Boolean);
  const publicGateway = cleaned.find((v) => !isLocalOrProxy(v));
  return publicGateway || getBrowserProxyGateway() || cleaned[0] || "";
}

// ── Strategy badges ───────────────────────────────────────────────────────────

function strategyBadge(intent?: BotIntent | null): string | null {
  if (!intent?.strategy) return null;
  const labels: Record<string, string> = {
    arbitrage: "⚡ Arbitrage",
    sniping: "🎯 Sniper",
    sentiment: "📰 Sentiment",
    whale_mirror: "🐋 Whale Mirror",
    dca: "📊 DCA",
    grid: "📐 Grid",
    perp: "📈 Perp/Funding",
    yield: "🌉 Yield/Bridge",
    mev_intent: "🛡️ MEV-Protected",
    scalper: "⚡ HF Scalper",
    news_reactive: "📰 News Trader",
    rebalancing: "⚖️ Rebalancer",
    ta_scripter: "📊 TA Trader",
    cross_chain_liquidation: "💥 Liquidation",
    cross_chain_arbitrage: "🌉 X-Chain Arb",
    cross_chain_sweep: "🔄 Yield Nomad",
    custom_utility: "🛠️ Custom",
  };
  return labels[intent.strategy] ?? intent.strategy;
}

function chainBadge(intent?: BotIntent | null): string {
  if (!intent) return "◎ Solana";
  const nets: Record<string, string> = {
    devnet: "◎ Solana Devnet",
    "mainnet-beta": "◎ Solana",
  };
  return nets[intent.network ?? ""] ?? "◎ Solana";
}

// ── Component ─────────────────────────────────────────────────────────────────

export function WebContainerBotRunner() {
  const [envConfig, setEnvConfig] = useState<BotEnvConfig>({
    ...DEFAULT_BOT_ENV_CONFIG,
  });
  const [fileEdits, setFileEdits] = useState<Record<string, string>>({});
  const [envLoaded, setEnvLoaded] = useState(false);
  const [intent, setIntent] = useState<BotIntent | null>(null);

  const didAutoLaunchRef = useRef(false);
  const shouldAutoLaunchRef = useRef(false);

  const { publicKey } = useWallet();
  const { terminalRef, termRef } = useTerminal();
  const { generateFiles, generatedFiles, selectedFile, setSelectedFile } =
    useBotCodeGen(termRef);
  const sandbox = useBotSandbox({
    generatedFiles: generatedFiles.map((f) => ({
      ...f,
      content:
        fileEdits[f.filepath] !== undefined ? fileEdits[f.filepath] : f.content,
    })),
    envConfig,
    termRef,
  });
  const { phase, setPhase, status, stopProcess, bootAndRun } = sandbox;

  const userWalletAddress = publicKey ? publicKey.toBase58() : "";
  const autosignEnabled = Boolean(userWalletAddress);
  const isRunning = phase === "running";

  // ── On mount: load files + env ────────────────────────────────────────────
  useEffect(() => {
    (async () => {
      const envDefaultsRes = await fetch("/api/env-defaults").catch(() => null);
      const envDefaultsJson =
        envDefaultsRes?.ok
          ? await envDefaultsRes.json().catch(() => null)
          : null;
      const sharedGateway =
        typeof envDefaultsJson?.values?.MCP_GATEWAY_URL === "string"
          ? envDefaultsJson.values.MCP_GATEWAY_URL
          : "";

      const result = await generateFiles();

      if (result?.loadedEnvConfig) {
        const loadedGateway = result.loadedEnvConfig?.MCP_GATEWAY_URL || "";
        setEnvConfig((prev) => ({
          ...prev,
          ...result.loadedEnvConfig,
          SOLANA_KEY: "",
          SESSION_KEY_MODE: "true",
          SIGNING_RELAY_BASE: getRuntimeRelayBase(prev.SIGNING_RELAY_BASE || ""),
          MCP_GATEWAY_URL: pickReachableGateway(
            loadedGateway,
            sharedGateway,
            prev.MCP_GATEWAY_URL,
            DEFAULT_BOT_ENV_CONFIG.MCP_GATEWAY_URL
          ),
        }));
      }

      setEnvLoaded(true);
      if (result?.intent) setIntent(result.intent);
      if (result?.success) shouldAutoLaunchRef.current = true;
      setPhase("idle");
    })();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Auto-launch after files + env are ready ───────────────────────────────
  useEffect(() => {
    if (didAutoLaunchRef.current) return;
    if (!shouldAutoLaunchRef.current) return;
    if (generatedFiles.length === 0) return;
    if (!envLoaded) return;
    if (!userWalletAddress) {
      termRef.current?.writeln(
        "\x1b[33m[System]\x1b[0m Connect a wallet before launching the bot."
      );
      shouldAutoLaunchRef.current = false;
      return;
    }

    didAutoLaunchRef.current = true;
    shouldAutoLaunchRef.current = false;
    setPhase("booting");

    void bootAndRun({
      ...envConfig,
      SESSION_KEY_MODE: "true",
      SOLANA_KEY: "",
      SIGNING_RELAY_BASE: getRuntimeRelayBase(envConfig.SIGNING_RELAY_BASE),
    });
  }, [generatedFiles.length, envLoaded, bootAndRun, envConfig, userWalletAddress, setPhase, termRef]);

  // ── Sync .env file edits → envConfig ─────────────────────────────────────
  useEffect(() => {
    const envFileEdit = fileEdits[".env"];
    if (!envFileEdit) return;
    const parsed: Record<string, string> = {};
    for (const rawLine of envFileEdit.split("\n")) {
      const line = rawLine.trim();
      if (!line || line.startsWith("#")) continue;
      const eqIdx = line.indexOf("=");
      if (eqIdx === -1) continue;
      const k = line.slice(0, eqIdx).trim();
      const v = line.slice(eqIdx + 1).trim();
      if (k) parsed[k] = v;
    }
    setEnvConfig((prev) => ({ ...prev, ...parsed }));
  }, [fileEdits]);

  const handleEditorChange = useCallback(
    (value: string) => {
      if (selectedFile) {
        setFileEdits((prev) => ({ ...prev, [selectedFile]: value }));
      }
    },
    [selectedFile]
  );

  const currentFiles = generatedFiles.map((f) => ({
    ...f,
    content:
      fileEdits[f.filepath] !== undefined ? fileEdits[f.filepath] : f.content,
  }));

  const selectedContent =
    currentFiles.find((f) => f.filepath === selectedFile)?.content ?? "";
  const isDryRun = envConfig.SIMULATION_MODE === "true";

  const handleLaunch = useCallback(() => {
    if (!userWalletAddress) {
      termRef.current?.writeln(
        "\x1b[31m[Error]\x1b[0m Connect wallet before launching the bot."
      );
      return;
    }
    if (!autosignEnabled) {
      termRef.current?.writeln(
        "\x1b[33m[System]\x1b[0m Enable AutoSign in the sidebar before launching."
      );
      return;
    }

    setPhase("booting");
    void bootAndRun({
      ...envConfig,
      SESSION_KEY_MODE: "true",
      SOLANA_KEY: "",
      SIGNING_RELAY_BASE: getRuntimeRelayBase(envConfig.SIGNING_RELAY_BASE),
    });
  }, [userWalletAddress, autosignEnabled, bootAndRun, envConfig, setPhase, termRef]);

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        height: "700px",
        background: "#020617",
        borderRadius: "12px",
        border: "1px solid #1e293b",
        overflow: "hidden",
        fontFamily: "Menlo, 'Courier New', monospace",
        color: "#e2e8f0",
        boxShadow: "0 25px 50px -12px rgba(0,0,0,0.8)",
        position: "relative",
      }}
    >
      <SigningRelayConsumer
        botRunning={isRunning}
        onLog={(line) => termRef.current?.writeln(`\x1b[35m${line}\x1b[0m`)}
      />

      {/* ── Header ─────────────────────────────────────────────────────────── */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "10px 16px",
          borderBottom: "1px solid #1e293b",
          background: "rgba(15,23,42,0.8)",
          flexShrink: 0,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <Zap size={14} color="#22d3ee" />
          <span style={{ fontSize: 12, fontWeight: 700, color: "#cbd5e1" }}>
            Bot IDE
          </span>
          {intent && (
            <>
              {strategyBadge(intent) && (
                <span
                  style={{
                    fontSize: 10,
                    padding: "2px 7px",
                    borderRadius: 20,
                    background: "rgba(34,211,238,0.08)",
                    border: "1px solid rgba(34,211,238,0.2)",
                    color: "#22d3ee",
                  }}
                >
                  {strategyBadge(intent)}
                </span>
              )}
              <span
                style={{
                  fontSize: 10,
                  padding: "2px 7px",
                  borderRadius: 20,
                  background: "rgba(139,92,246,0.08)",
                  border: "1px solid rgba(139,92,246,0.2)",
                  color: "#a78bfa",
                }}
              >
                {chainBadge(intent)}
              </span>
            </>
          )}
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span
            style={{
              fontSize: 10,
              background: envLoaded
                ? "rgba(34,197,94,0.1)"
                : "rgba(251,191,36,0.1)",
              padding: "2px 8px",
              borderRadius: 4,
              border: `1px solid ${envLoaded ? "rgba(34,197,94,0.3)" : "rgba(251,191,36,0.3)"}`,
              color: envLoaded ? "#4ade80" : "#fbbf24",
            }}
          >
            {envLoaded ? "ENV ✓" : "ENV …"}
          </span>

          <span
            style={{
              fontSize: 10,
              background: "#0f172a",
              padding: "2px 8px",
              borderRadius: 4,
              border: "1px solid #1e293b",
              color: "#64748b",
            }}
          >
            {status?.toUpperCase() ?? "IDLE"}
          </span>

          {isDryRun && (
            <span
              style={{
                fontSize: 10,
                background: "rgba(250,204,21,0.1)",
                padding: "2px 8px",
                borderRadius: 4,
                border: "1px solid rgba(250,204,21,0.3)",
                color: "#fbbf24",
              }}
            >
              SIM
            </span>
          )}

          <span
            style={{
              fontSize: 10,
              background: userWalletAddress
                ? "rgba(34,197,94,0.1)"
                : "rgba(239,68,68,0.1)",
              padding: "2px 8px",
              borderRadius: 4,
              border: `1px solid ${userWalletAddress ? "rgba(34,197,94,0.3)" : "rgba(239,68,68,0.3)"}`,
              color: userWalletAddress ? "#4ade80" : "#fca5a5",
              display: "flex",
              alignItems: "center",
              gap: 4,
            }}
          >
            {userWalletAddress ? <ShieldCheck size={10} /> : <ShieldOff size={10} />}
            {userWalletAddress ? "Wallet Connected" : "Wallet Not Connected"}
          </span>

          <button
            type="button"
            style={{
              display: "flex",
              alignItems: "center",
              gap: 5,
              background: "#1e293b",
              border: "1px solid #334155",
              borderRadius: 6,
              padding: "5px 10px",
              color: "#94a3b8",
              fontSize: 11,
              fontWeight: 600,
              fontFamily: "inherit",
              cursor: "default",
            }}
            title={userWalletAddress ? "Bot will sign transactions using your connected wallet." : "Connect wallet to enable signing."}
          >
            <Bot size={11} /> {userWalletAddress ? "Wallet Ready" : "No Wallet"}
          </button>

          {isRunning ? (
            <button
              onClick={stopProcess}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 5,
                background: "#7f1d1d",
                border: "1px solid #991b1b",
                borderRadius: 6,
                padding: "5px 12px",
                color: "#fca5a5",
                fontSize: 11,
                fontWeight: 700,
                cursor: "pointer",
                fontFamily: "inherit",
              }}
            >
              <Square size={10} fill="currentColor" /> Stop
            </button>
          ) : generatedFiles.length === 0 ? (
            <button
              disabled
              style={{
                display: "flex",
                alignItems: "center",
                gap: 5,
                background: "#1e293b",
                border: "1px solid #334155",
                borderRadius: 6,
                padding: "5px 12px",
                color: "#475569",
                fontSize: 11,
                fontWeight: 700,
                cursor: "not-allowed",
                fontFamily: "inherit",
              }}
            >
              <Play size={11} fill="currentColor" /> Loading…
            </button>
          ) : (
            <button
              onClick={handleLaunch}
              disabled={!userWalletAddress}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 5,
                background: userWalletAddress ? "#059669" : "#1e293b",
                border: userWalletAddress ? "1px solid #10b981" : "1px solid #334155",
                borderRadius: 6,
                padding: "5px 12px",
                color: userWalletAddress ? "#a7f3d0" : "#64748b",
                fontSize: 11,
                fontWeight: 700,
                cursor: userWalletAddress ? "pointer" : "not-allowed",
                fontFamily: "inherit",
              }}
            >
              <Play size={11} fill="currentColor" /> Launch Bot
            </button>
          )}
        </div>
      </div>

      {/* ── Main body ──────────────────────────────────────────────────────── */}
      <div style={{ display: "flex", flex: 1, overflow: "hidden" }}>
        <FileExplorer
          files={currentFiles}
          selectedFile={selectedFile}
          onSelect={setSelectedFile}
        />

        <div
          style={{
            display: "flex",
            flexDirection: "column",
            flex: 1,
            minWidth: 0,
          }}
        >
          <div
            style={{
              flex: 1,
              position: "relative",
              display: "flex",
              flexDirection: "column",
              minHeight: 0,
            }}
          >
            <CodeEditor
              content={selectedContent}
              onChange={handleEditorChange}
            />
          </div>
          <TerminalPanel
            terminalRef={terminalRef}
            onClear={() => termRef.current?.clear()}
          />
        </div>
      </div>
    </div>
  );
}
