"use client";

import { use, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { ChevronLeft, FileCode, TerminalSquare } from "lucide-react";
import { Panel, PanelGroup, PanelResizeHandle } from "react-resizable-panels";
import { CodeEditor } from "@/components/ui/code-editor";

interface TerminalEntry {
  line: string;
  level: "stdout" | "stderr";
  ts: number;
}

interface AgentFile {
  filepath: string;
  content: string;
}

// Fetch live backend logs
async function fetchTerminalLogs(agentId: string, since?: number): Promise<TerminalEntry[]> {
  const url = new URL(`/api/agents/${agentId}/terminal-logs`, window.location.origin);
  if (since) url.searchParams.set("since", String(since));
  const res = await fetch(url.toString(), { cache: "no-store" });
  if (!res.ok) return [];
  const data = await res.json();
  return Array.isArray(data?.entries) ? data.entries : [];
}

// Fetch the generated files for the bot
async function fetchAgentFiles(agentId: string): Promise<AgentFile[]> {
  try {
    const res = await fetch(`/api/agents/${agentId}`);
    if (!res.ok) return [];
    const data = await res.json();
    const fetchedFiles = Array.isArray(data?.files) ? data.files : [];
    return fetchedFiles.map((f: { filepath?: string; content?: string }) => ({
      filepath: f.filepath || "unknown.ts",
      content: f.content || "// File empty",
    }));
  } catch (err) {
    console.error("Failed to fetch agent files", err);
    return [];
  }
}

function formatTime(ts: number): string {
  const d = new Date(ts);
  return [d.getHours(), d.getMinutes(), d.getSeconds()]
    .map((n) => String(n).padStart(2, "0"))
    .join(":");
}

export default function DeployCodePage({ params }: { params: Promise<{ id: string }> }) {
  const { id: agentId } = use(params);
  
  // Terminal State
  const [entries, setEntries] = useState<TerminalEntry[]>([]);
  const [lastError, setLastError] = useState<string | null>(null);
  const sinceRef = useRef<number>(0);
  const bottomRef = useRef<HTMLDivElement>(null);
  const logCount = useMemo(() => entries.length, [entries]);

  // Files State
  const [files, setFiles] = useState<AgentFile[]>([]);
  const [selectedFile, setSelectedFile] = useState<string | null>(null);

  // 1. Fetch Files on Mount
  useEffect(() => {
    fetchAgentFiles(agentId).then((fetchedFiles) => {
      setFiles(fetchedFiles);
      if (fetchedFiles.length > 0) {
        const indexFile = fetchedFiles.find((f) => f.filepath.includes("index.ts"));
        setSelectedFile(indexFile ? indexFile.filepath : fetchedFiles[0].filepath);
      }
    });
  }, [agentId]);

  // 2. Poll Terminal Logs
  useEffect(() => {
    let mounted = true;

    fetchTerminalLogs(agentId).then((rows) => {
      if (!mounted) return;
      setEntries(rows.slice(-500));
      if (rows.length > 0) sinceRef.current = rows[rows.length - 1].ts;
    }).catch((err) => {
      if (!mounted) return;
      setLastError(err instanceof Error ? err.message : String(err));
    });

    const interval = setInterval(async () => {
      try {
        const rows = await fetchTerminalLogs(agentId, sinceRef.current);
        if (rows.length > 0) {
          setEntries((prev) => [...prev, ...rows].slice(-500));
          sinceRef.current = rows[rows.length - 1].ts;
        }
        setLastError(null);
      } catch (err) {
        setLastError(err instanceof Error ? err.message : String(err));
      }
    }, 2000);

    return () => {
      mounted = false;
      clearInterval(interval);
    };
  }, [agentId]);

  // Auto-scroll terminal
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [entries]);

  const activeContent = files.find(f => f.filepath === selectedFile)?.content;

  return (
    <div className="flex flex-col h-screen bg-background overflow-hidden">
      {/* Header */}
      <div className="flex-shrink-0 bg-background border-b border-border px-6 py-3 flex items-center justify-between z-10">
        <div className="flex items-center gap-4">
          <Link href={`/dashboard/agents/${agentId}`}>
            <Button variant="ghost" size="sm" className="h-8 text-muted-foreground hover:text-foreground">
              <ChevronLeft size={16} className="mr-1" /> Back
            </Button>
          </Link>
          <div className="h-4 w-[1px] bg-border" />
          <div className="flex items-center gap-2">
            <TerminalSquare size={16} className="text-cyan-500" />
            <h1 className="text-sm font-semibold tracking-wide">IDE Preview</h1>
            <span className="text-xs text-muted-foreground bg-muted px-2 py-0.5 rounded-md ml-2">
              Agent ID: {agentId.slice(0, 8)}
            </span>
          </div>
        </div>
      </div>

      {/* Main IDE Layout */}
      <div className="flex-1 flex overflow-hidden">
        
        {/* Left Sidebar: File Explorer */}
        <div className="w-64 flex-shrink-0 bg-[#06080c] border-r border-border flex flex-col">
          <div className="px-4 py-3 border-b border-border/50 text-xs font-semibold text-muted-foreground uppercase tracking-wider">
            Explorer
          </div>
          <div className="flex-1 overflow-y-auto py-2">
            {files.length === 0 ? (
              <div className="px-4 text-xs text-muted-foreground/50">No files generated yet...</div>
            ) : (
              files.map((file) => (
                <button
                  key={file.filepath}
                  onClick={() => setSelectedFile(file.filepath)}
                  className={`w-full flex items-center gap-2 px-4 py-1.5 text-xs text-left transition-colors ${
                    selectedFile === file.filepath
                      ? "bg-cyan-500/10 text-cyan-400 border-r-2 border-cyan-500"
                      : "text-slate-400 hover:text-slate-200 hover:bg-white/5"
                  }`}
                >
                  <FileCode size={14} className={selectedFile === file.filepath ? "text-cyan-400" : "text-slate-500"} />
                  <span className="truncate">{file.filepath}</span>
                </button>
              ))
            )}
          </div>
        </div>

        {/* Right Area: Resizable Editor & Terminal */}
        <div className="flex-1 flex flex-col min-w-0 bg-[#0a0d14]">
          <PanelGroup direction="vertical">
            
            {/* Top Panel: Code Editor */}
            <Panel defaultSize={65} minSize={20}>
              <div className="h-full flex flex-col">
                <div className="bg-[#06080c] border-b border-border/50 flex text-xs">
                  {selectedFile && (
                    <div className="px-4 py-2 border-r border-border/50 bg-[#0a0d14] text-cyan-400 flex items-center gap-2">
                      <FileCode size={13} /> {selectedFile}
                    </div>
                  )}
                </div>
                <div className="flex-1 relative overflow-hidden">
                  <CodeEditor content={activeContent || "Loading..."} />
                </div>
              </div>
            </Panel>

            <PanelResizeHandle className="h-1.5 bg-border/50 hover:bg-cyan-500/50 transition-colors cursor-row-resize" />

            {/* Bottom Panel: Terminal */}
            <Panel defaultSize={35} minSize={20}>
              <div className="h-full flex flex-col">
                <div className="bg-[#06080c] border-b border-border/50 px-4 py-2 flex items-center justify-between">
                  <div className="flex items-center gap-3 text-xs font-semibold text-muted-foreground uppercase tracking-wider">
                    Terminal Output
                    <span className="inline-flex items-center gap-1 text-[10px] text-cyan-500/70 lowercase normal-case">
                      <span className="w-1.5 h-1.5 rounded-full bg-cyan-500 animate-pulse" /> Live Polling
                    </span>
                  </div>
                  <div className="text-[10px] text-muted-foreground">{logCount} lines</div>
                </div>
                <div className="flex-1 overflow-y-auto p-4 font-mono text-xs space-y-1 bg-[#0a0d14]">
                  {lastError && (
                    <div className="text-red-400 mb-2">Error connecting to telemetry: {lastError}</div>
                  )}
                  {entries.length === 0 ? (
                    <span className="text-muted-foreground/50">Waiting for backend execution logs...</span>
                  ) : (
                    entries.map((entry, idx) => (
                      <div key={`${entry.ts}-${idx}`} className="flex gap-3 leading-relaxed hover:bg-white/[0.02] px-1 rounded">
                        <span className="text-muted-foreground/40 flex-shrink-0 select-none">
                          {formatTime(entry.ts)}
                        </span>
                        <span className={entry.level === "stderr" ? "text-red-400" : "text-green-300"}>
                          {entry.line}
                        </span>
                      </div>
                    ))
                  )}
                  <div ref={bottomRef} />
                </div>
              </div>
            </Panel>

          </PanelGroup>
        </div>

      </div>
    </div>
  );
}