/* eslint-disable no-control-regex */
"use client";

/**
 * frontend/app/dashboard/deploy/[agentId]/code/page.tsx
 *
 * Bot IDE page — loads agent files from the DB and displays them
 * in a code editor with start/stop controls and a live terminal.
 */

import React, { useCallback, useEffect, useRef, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import {
  Play, Square, RefreshCw, ChevronLeft, File,
  Terminal, Loader2, Copy, Check, Download,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { useAuthHeaders } from "@/lib/auth/privy-client";

// ── Types ─────────────────────────────────────────────────────────────────────

interface BotFile {
  filepath: string;
  content: string;
  language?: string;
}

interface AgentData {
  agentId: string;
  name: string;
  status: string;
  walletAddress: string;
  files: BotFile[];
  config?: Record<string, unknown>;
}

interface TerminalEntry {
  ts: string;
  level: string;
  line: string;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function langFromPath(filepath: string): string {
  if (filepath.endsWith(".ts") || filepath.endsWith(".tsx")) return "typescript";
  if (filepath.endsWith(".js") || filepath.endsWith(".jsx")) return "javascript";
  if (filepath.endsWith(".json")) return "json";
  if (filepath.endsWith(".md")) return "markdown";
  if (filepath.endsWith(".env") || filepath.endsWith(".example")) return "shell";
  if (filepath.endsWith(".toml") || filepath.endsWith(".yaml") || filepath.endsWith(".yml")) return "yaml";
  return "plaintext";
}

function fileIcon(filepath: string): string {
  if (filepath.endsWith(".ts") || filepath.endsWith(".tsx")) return "TS";
  if (filepath.endsWith(".js") || filepath.endsWith(".jsx")) return "JS";
  if (filepath.endsWith(".json")) return "{}";
  if (filepath.endsWith(".md")) return "MD";
  if (filepath.includes(".env")) return "ENV";
  return "—";
}

function statusBadgeClass(status: string): string {
  const map: Record<string, string> = {
    RUNNING:  "bg-green-500/20 text-green-300 border-green-500/30",
    STARTING: "bg-blue-500/20 text-blue-300 border-blue-500/30",
    STOPPING: "bg-yellow-500/20 text-yellow-300 border-yellow-500/30",
    STOPPED:  "bg-gray-500/20 text-gray-300 border-gray-500/30",
    ERROR:    "bg-red-500/20 text-red-300 border-red-500/30",
  };
  return map[status] ?? map.STOPPED;
}

const ANSI_RE = /\x1B\[[0-9;]*m/g;
function stripAnsi(s: string) { return s.replace(ANSI_RE, ""); }

// ── Main component ────────────────────────────────────────────────────────────

export default function BotCodePage() {
  const params = useParams();
  const agentId = String(params?.agentId ?? "");
  const router = useRouter();
  const getAuthHeaders = useAuthHeaders();

  const [agent, setAgent] = useState<AgentData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const [actionLoading, setActionLoading] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const [termLines, setTermLines] = useState<TerminalEntry[]>([]);
  const [termSince, setTermSince] = useState<string | null>(null);
  const termPollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const termBottomRef = useRef<HTMLDivElement>(null);

  // ── Load agent files ───────────────────────────────────────────────────────

  const loadAgent = useCallback(async () => {
    if (!agentId) return;
    setLoading(true);
    setError(null);
    try {
      const headers = await getAuthHeaders();
      const res = await fetch(`/api/get-latest-bot?agentId=${agentId}`, { headers });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error((body as { error?: string }).error ?? `HTTP ${res.status}`);
      }
      const data = (await res.json()) as AgentData;
      setAgent(data);

      // Default to src/index.ts (not .env)
      const main = data.files.find(
        (f) => f.filepath === "src/index.ts" || f.filepath === "src/index.js" || f.filepath === "main.py"
      );
      setSelectedFile(main?.filepath ?? data.files.find((f) => !f.filepath.includes(".env"))?.filepath ?? data.files[0]?.filepath ?? null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [agentId, getAuthHeaders]);

  useEffect(() => { loadAgent(); }, [loadAgent]);

  // ── Terminal polling ───────────────────────────────────────────────────────

  const pollTerminal = useCallback(async () => {
    if (!agentId) return;
    try {
      const headers = await getAuthHeaders();
      const url = termSince
        ? `/api/agents/${agentId}/terminal-logs?since=${encodeURIComponent(termSince)}`
        : `/api/agents/${agentId}/terminal-logs`;
      const res = await fetch(url, { headers, cache: "no-store" });
      if (!res.ok) return;
      const data = (await res.json()) as { entries?: TerminalEntry[] };
      const entries = data.entries ?? [];
      if (entries.length > 0) {
        setTermLines((prev) => {
          const combined = [...prev, ...entries].slice(-500);
          return combined;
        });
        setTermSince(entries[entries.length - 1].ts);
      }
    } catch {
      // silently ignore poll errors
    }
  }, [agentId, termSince, getAuthHeaders]);

  // Start/stop terminal polling based on agent status
  useEffect(() => {
    const isActive = agent?.status === "RUNNING" || agent?.status === "STARTING";
    if (isActive) {
      if (!termPollRef.current) {
        termPollRef.current = setInterval(pollTerminal, 2000);
      }
    } else {
      if (termPollRef.current) {
        clearInterval(termPollRef.current);
        termPollRef.current = null;
      }
      // Do one final poll to get any last output
      pollTerminal();
    }
    return () => {
      if (termPollRef.current) clearInterval(termPollRef.current);
    };
  }, [agent?.status, pollTerminal]);

  // Auto-scroll terminal
  useEffect(() => {
    termBottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [termLines]);

  // ── Start / Stop ───────────────────────────────────────────────────────────

  const handleToggle = async () => {
    if (!agent) return;
    const action = agent.status === "RUNNING" ? "stop" : "start";
    setActionLoading(true);
    setActionError(null);
    try {
      const headers = await getAuthHeaders();
      const res = await fetch(`/api/agents/${agentId}/${action}`, {
        method: "POST",
        headers,
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error((body as { error?: string }).error ?? `HTTP ${res.status}`);
      }
      // Reload agent to pick up new status
      setTimeout(loadAgent, 800);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    } finally {
      setActionLoading(false);
    }
  };

  // ── Copy file ──────────────────────────────────────────────────────────────

  const handleCopy = () => {
    const file = agent?.files.find((f) => f.filepath === selectedFile);
    if (!file) return;
    navigator.clipboard.writeText(file.content).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };

  // ── Download file ─────────────────────────────────────────────────────────

  const handleDownload = () => {
    const file = agent?.files.find((f) => f.filepath === selectedFile);
    if (!file) return;
    const blob = new Blob([file.content], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = file.filepath.split("/").pop() ?? "file.ts";
    a.click();
    URL.revokeObjectURL(url);
  };

  // ── Render ─────────────────────────────────────────────────────────────────

  if (loading) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <div className="flex flex-col items-center gap-3">
          <div className="w-8 h-8 border-2 border-primary border-t-transparent rounded-full animate-spin" />
          <p className="text-sm text-muted-foreground">Loading bot files…</p>
        </div>
      </div>
    );
  }

  if (error || !agent) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center p-6">
        <div className="text-center space-y-4 max-w-md">
          <p className="text-destructive text-sm">{error ?? "Bot not found."}</p>
          <Button variant="outline" size="sm" onClick={() => router.push("/dashboard")}>
            <ChevronLeft size={14} className="mr-1" /> Back to Dashboard
          </Button>
        </div>
      </div>
    );
  }

  // Deduplicate by filepath to avoid duplicate React keys and ambiguous selection.
  const uniqueFiles = agent.files.filter(
    (file, index, arr) => arr.findIndex((candidate) => candidate.filepath === file.filepath) === index,
  );

  const selectedContent = uniqueFiles.find((f) => f.filepath === selectedFile)?.content ?? "";
  const isRunning = agent.status === "RUNNING";
  const isTransitioning = agent.status === "STARTING" || agent.status === "STOPPING";

  // Sort files: src/ first, then others, .env last
  const sortedFiles = [...uniqueFiles].sort((a, b) => {
    const isEnvA = a.filepath.includes(".env");
    const isEnvB = b.filepath.includes(".env");
    if (isEnvA && !isEnvB) return 1;
    if (!isEnvA && isEnvB) return -1;
    return a.filepath.localeCompare(b.filepath);
  });

  return (
    <div className="flex flex-col h-screen bg-background text-foreground overflow-hidden">

      {/* ── Top bar ── */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-border bg-background/95 backdrop-blur-sm flex-shrink-0">
        <div className="flex items-center gap-3">
          <button
            onClick={() => router.push("/dashboard")}
            className="text-muted-foreground hover:text-foreground transition-colors"
          >
            <ChevronLeft size={18} />
          </button>
          <div>
            <h1 className="text-sm font-bold text-foreground">{agent.name}</h1>
            <p className="text-xs text-muted-foreground font-mono truncate max-w-[200px]">
              {agentId}
            </p>
          </div>
          <Badge className={statusBadgeClass(agent.status)}>
            {agent.status}
            {isTransitioning && (
              <Loader2 size={10} className="animate-spin ml-1" />
            )}
          </Badge>
        </div>

        <div className="flex items-center gap-2">
          {actionError && (
            <span className="text-xs text-destructive max-w-[200px] truncate">{actionError}</span>
          )}
          <Button
            size="sm"
            variant="ghost"
            onClick={loadAgent}
            disabled={loading}
            className="text-muted-foreground hover:text-foreground"
          >
            <RefreshCw size={14} />
          </Button>
          <Button
            size="sm"
            onClick={handleToggle}
            disabled={actionLoading || isTransitioning}
            className={
              isRunning
                ? "bg-red-500/10 text-red-400 border border-red-500/30 hover:bg-red-500/20"
                : "bg-green-500/10 text-green-400 border border-green-500/30 hover:bg-green-500/20"
            }
          >
            {actionLoading ? (
              <Loader2 size={13} className="animate-spin mr-1.5" />
            ) : isRunning ? (
              <Square size={13} className="mr-1.5" />
            ) : (
              <Play size={13} className="mr-1.5" />
            )}
            {isRunning ? "Stop Bot" : "Start Bot"}
          </Button>
        </div>
      </div>

      {/* ── Main body: file tree + editor + terminal ── */}
      <div className="flex flex-1 overflow-hidden">

        {/* File tree */}
        <div className="w-52 flex-shrink-0 border-r border-border bg-sidebar overflow-y-auto">
          <div className="px-3 py-2 border-b border-sidebar-border">
            <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
              Files ({sortedFiles.length})
            </p>
          </div>
          <div className="py-1">
            {sortedFiles.map((file) => {
              const isActive = file.filepath === selectedFile;
              const isEnv = file.filepath.includes(".env");
              return (
                <button
                  key={file.filepath}
                  onClick={() => setSelectedFile(file.filepath)}
                  className={`w-full flex items-center gap-2 px-3 py-2 text-left text-xs transition-colors ${
                    isActive
                      ? "bg-primary/15 text-primary border-r-2 border-primary"
                      : "text-muted-foreground hover:text-foreground hover:bg-muted/20"
                  }`}
                >
                  <span className={`font-mono text-[9px] w-6 text-center shrink-0 px-0.5 rounded ${
                    isEnv ? "bg-yellow-500/20 text-yellow-400" : "bg-muted/30 text-muted-foreground"
                  }`}>
                    {fileIcon(file.filepath)}
                  </span>
                  <span className="truncate">{file.filepath.split("/").pop()}</span>
                </button>
              );
            })}
          </div>
        </div>

        {/* Editor + terminal */}
        <div className="flex flex-col flex-1 overflow-hidden">

          {/* Editor */}
          <div className="flex flex-col flex-1 overflow-hidden" style={{ height: "60%" }}>
            {/* Editor header */}
            <div className="flex items-center justify-between px-4 py-2 border-b border-border bg-card/30 flex-shrink-0">
              <div className="flex items-center gap-2">
                <File size={13} className="text-muted-foreground" />
                <span className="text-xs font-mono text-foreground">
                  {selectedFile ?? "—"}
                </span>
                {selectedFile && (
                  <span className="text-[10px] bg-muted/30 border border-border rounded px-1.5 py-0.5 text-muted-foreground">
                    {langFromPath(selectedFile)}
                  </span>
                )}
              </div>
              <div className="flex items-center gap-1.5">
                <button
                  onClick={handleCopy}
                  className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors px-2 py-1 rounded hover:bg-muted/20"
                >
                  {copied ? <Check size={12} className="text-green-400" /> : <Copy size={12} />}
                  {copied ? "Copied" : "Copy"}
                </button>
                <button
                  onClick={handleDownload}
                  className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors px-2 py-1 rounded hover:bg-muted/20"
                >
                  <Download size={12} />
                  Download
                </button>
              </div>
            </div>

            {/* Code content */}
            <div className="flex-1 overflow-auto bg-[#2a0e1e]">
              {selectedContent ? (
                <pre className="p-4 text-xs font-mono text-foreground/85 leading-relaxed whitespace-pre overflow-x-auto min-h-full">
                  <code>{selectedContent}</code>
                </pre>
              ) : (
                <div className="flex items-center justify-center h-full">
                  <p className="text-muted-foreground text-sm">Select a file to view its contents</p>
                </div>
              )}
            </div>
          </div>

          {/* Terminal */}
          <div className="flex flex-col border-t border-border" style={{ height: "40%" }}>
            <div className="flex items-center justify-between px-4 py-2 border-b border-border bg-card/30 flex-shrink-0">
              <div className="flex items-center gap-2">
                <Terminal size={13} className="text-muted-foreground" />
                <span className="text-xs font-semibold text-foreground">Terminal</span>
                {isRunning && (
                  <span className="w-1.5 h-1.5 rounded-full bg-green-400 animate-pulse" />
                )}
              </div>
              <button
                onClick={() => setTermLines([])}
                className="text-xs text-muted-foreground hover:text-foreground transition-colors"
              >
                Clear
              </button>
            </div>

            <div className="flex-1 overflow-y-auto bg-[#1a0810] p-3 font-mono text-xs">
              {termLines.length === 0 ? (
                <div className="text-muted-foreground/50">
                  <span className="text-green-400">$</span>{" "}
                  {isRunning ? "Agent is running — waiting for output…" : "Start the bot to see terminal output."}
                </div>
              ) : (
                termLines.map((entry, i) => (
                  <div key={i} className="leading-relaxed flex gap-2">
                    <span className="text-muted-foreground/40 shrink-0 select-none">
                      {new Date(entry.ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}
                    </span>
                    <span className={
                      entry.level === "stderr"
                        ? "text-red-400"
                        : "text-foreground/80"
                    }>
                      {stripAnsi(entry.line)}
                    </span>
                  </div>
                ))
              )}
              <div ref={termBottomRef} />
            </div>
          </div>

        </div>
      </div>
    </div>
  );
}