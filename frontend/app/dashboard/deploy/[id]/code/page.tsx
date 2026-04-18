"use client";

import { use, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { ChevronLeft, RefreshCw } from "lucide-react";

interface TerminalEntry {
  line: string;
  level: "stdout" | "stderr";
  ts: number;
}

async function fetchTerminalLogs(agentId: string, since?: number): Promise<TerminalEntry[]> {
  const url = new URL(`/api/agents/${agentId}/terminal-logs`, window.location.origin);
  if (since) url.searchParams.set("since", String(since));
  const res = await fetch(url.toString(), { cache: "no-store" });
  if (!res.ok) return [];
  const data = await res.json();
  return Array.isArray(data?.entries) ? data.entries : [];
}

function formatTime(ts: number): string {
  const d = new Date(ts);
  return [d.getHours(), d.getMinutes(), d.getSeconds()]
    .map((n) => String(n).padStart(2, "0"))
    .join(":");
}

export default function DeployCodePage({ params }: { params: Promise<{ id: string }> }) {
  const { id: agentId } = use(params);
  const [entries, setEntries] = useState<TerminalEntry[]>([]);
  const polling = true;
  const [lastError, setLastError] = useState<string | null>(null);
  const sinceRef = useRef<number>(0);
  const bottomRef = useRef<HTMLDivElement>(null);

  const logCount = useMemo(() => entries.length, [entries]);

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

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [entries]);

  const handleRefresh = async () => {
    try {
      const rows = await fetchTerminalLogs(agentId);
      setEntries(rows.slice(-500));
      sinceRef.current = rows.length > 0 ? rows[rows.length - 1].ts : 0;
      setLastError(null);
    } catch (err) {
      setLastError(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <div className="min-h-screen bg-background">
      <div className="sticky top-0 z-30 bg-background border-b border-border">
        <div className="px-6 py-4 lg:px-8 flex items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <Link href={`/dashboard/agents/${agentId}`}>
              <Button variant="ghost" size="sm">
                <ChevronLeft size={16} className="mr-1" /> Back to Agent
              </Button>
            </Link>
            <div>
              <h1 className="text-2xl font-bold">Backend Telemetry Console</h1>
              <p className="text-sm text-muted-foreground">Agent {agentId}</p>
            </div>
          </div>
          <Button variant="outline" size="sm" onClick={handleRefresh}>
            <RefreshCw size={14} className="mr-1" /> Refresh
          </Button>
        </div>
      </div>

      <div className="px-6 py-6 lg:px-8">
        {lastError && (
          <div className="mb-4 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-400">
            {lastError}
          </div>
        )}

        <div className="bg-card border border-border rounded-lg overflow-hidden flex flex-col h-[560px]">
          <div className="bg-muted/30 border-b border-border px-4 py-3 flex items-center justify-between">
            <h3 className="text-sm font-semibold">Terminal Logs</h3>
            <div className="flex items-center gap-3 text-xs text-muted-foreground">
              <span>{logCount} lines</span>
              {polling && <span className="inline-flex items-center gap-1"><span className="w-1.5 h-1.5 rounded-full bg-green-400 animate-pulse" />Polling 2s</span>}
            </div>
          </div>

          <div className="flex-1 overflow-y-auto bg-[#0a0d14] p-4 font-mono text-xs space-y-1">
            {entries.length === 0 ? (
              <span className="text-muted-foreground/50">No terminal output yet. Start the agent to stream backend logs.</span>
            ) : (
              entries.map((entry, idx) => (
                <div key={`${entry.ts}-${idx}`} className="flex gap-3 leading-relaxed">
                  <span className="text-muted-foreground/40 flex-shrink-0 select-none">{formatTime(entry.ts)}</span>
                  <span className={entry.level === "stderr" ? "text-red-400" : "text-green-300"}>{entry.line}</span>
                </div>
              ))
            )}
            <div ref={bottomRef} />
          </div>
        </div>
      </div>
    </div>
  );
}