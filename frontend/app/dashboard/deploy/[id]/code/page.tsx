"use client";

import { use, useEffect, useRef, useState, useCallback } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { ChevronLeft, FileCode, TerminalSquare, Play, Square, Loader2 } from "lucide-react";
import { Panel, PanelGroup, PanelResizeHandle } from "react-resizable-panels";
import { CodeEditor } from "@/components/ui/code-editor";
import { useWallet } from "@solana/wallet-adapter-react";
import { getWalletAuthHeaders } from "@/lib/auth/client";
import type { WebContainer, FileSystemTree } from "@webcontainer/api";
import "@xterm/xterm/css/xterm.css";

interface AgentFile {
  filepath: string;
  content: string;
}

interface AgentFileResponse {
  files?: Array<{
    filepath?: string;
    content?: string;
  }>;
}

// Singleton to prevent double-boot in React Strict Mode / hot reloads
let wcInstance: WebContainer | null = null;
let wcBooting: Promise<WebContainer> | null = null;

async function getWebContainer(): Promise<WebContainer> {
  if (wcInstance) return wcInstance;
  if (wcBooting) return wcBooting;

  wcBooting = (async () => {
    const { WebContainer } = await import("@webcontainer/api");
    wcInstance = await WebContainer.boot();
    return wcInstance;
  })();

  return wcBooting;
}

function buildFileSystemTree(files: AgentFile[]): FileSystemTree {
  const tree: FileSystemTree = {};

  for (const file of files) {
    const filepath = file.filepath.replace(/^\//, "");
    if (!filepath) continue;

    const parts = filepath.split("/").filter(Boolean);
    if (parts.length === 0) continue;

    let node: FileSystemTree = tree;

    for (let i = 0; i < parts.length - 1; i++) {
      const part = parts[i];
      if (!node[part]) {
        node[part] = { directory: {} };
      }
      node = (node[part] as { directory: FileSystemTree }).directory;
    }

    const filename = parts[parts.length - 1];
    node[filename] = { file: { contents: file.content } };
  }

  return tree;
}

export default function DeployCodePage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id: agentId } = use(params);
  const { publicKey, signMessage } = useWallet();

  const [files, setFiles] = useState<AgentFile[]>([]);
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [isBooting, setIsBooting] = useState(true);
  const [isRunning, setIsRunning] = useState(false);
  const [bootError, setBootError] = useState<string | null>(null);

  const terminalDivRef = useRef<HTMLDivElement>(null);
  const xtermRef = useRef<import("@xterm/xterm").Terminal | null>(null);
  const fitAddonRef = useRef<import("@xterm/addon-fit").FitAddon | null>(null);
  const processRef = useRef<Awaited<ReturnType<WebContainer["spawn"]>> | null>(null);
  const containerReadyRef = useRef(false);

  // ── 1. Fetch agent files ────────────────────────────────────────────────
  useEffect(() => {
    let cancelled = false;

    async function fetchFiles() {
      try {
        if (!publicKey) {
          throw new Error("Connect your wallet to load agent code.");
        }

        const authHeaders = await getWalletAuthHeaders({ publicKey, signMessage });
        const res = await fetch(`/api/agents/${agentId}`, {
          headers: { ...authHeaders },
        });

        if (cancelled) return;

        if (!res.ok) {
          const body = await res.json().catch(() => ({} as Record<string, unknown>));
          const message = typeof body.error === "string" ? body.error : `Failed to load agent code (${res.status}).`;
          throw new Error(message);
        }

        const data = (await res.json()) as AgentFileResponse;
        const raw: AgentFile[] = (data.files ?? []).map(
          (f: { filepath?: string; content?: string }) => ({
            filepath: f.filepath ?? "unknown.ts",
            content: f.content ?? "",
          })
        );

        if (cancelled) return;

        setFiles(raw);
        const preferred = raw.find((f) => f.filepath === "src/index.ts");
        setSelectedFile(preferred?.filepath ?? raw[0]?.filepath ?? null);
        if (raw.length === 0) {
          setBootError("No code files were found for this agent.");
          setIsBooting(false);
        }
      } catch (err) {
        if (cancelled) return;

        console.error("Failed to fetch files", err);
        setBootError(err instanceof Error ? err.message : "Failed to load agent code.");
        setIsBooting(false);
      }
    }

    fetchFiles();

    return () => {
      cancelled = true;
    };
  }, [agentId, publicKey, signMessage]);

  // ── 2. Boot terminal + WebContainer once files arrive ──────────────────
  useEffect(() => {
    if (files.length === 0) return;
    if (!terminalDivRef.current) return;
    if (containerReadyRef.current) return;
    containerReadyRef.current = true;

    let cancelled = false;

    async function boot() {
      // Dynamically import xterm (browser-only)
      const { Terminal } = await import("@xterm/xterm");
      const { FitAddon } = await import("@xterm/addon-fit");

      if (cancelled) return;

      // Mount terminal
      const term = new Terminal({
        theme: {
          background: "#0a0d14",
          foreground: "#e2e8f0",
          cursor: "#0ea5e9",
        },
        fontFamily: '"Geist Mono", "Fira Code", monospace',
        fontSize: 12,
        lineHeight: 1.5,
        cursorBlink: true,
      });
      const fit = new FitAddon();
      term.loadAddon(fit);
      term.open(terminalDivRef.current!);
      fit.fit();
      xtermRef.current = term;
      fitAddonRef.current = fit;

      const handleResize = () => fit.fit();
      window.addEventListener("resize", handleResize);

      term.writeln("\x1b[1;36m◆ Booting WebContainer…\x1b[0m");

      try {
        const wc = await getWebContainer();
        if (cancelled) return;

        term.writeln("\x1b[1;36m◆ Mounting files…\x1b[0m");
        const tree = buildFileSystemTree(files);
        await wc.mount(tree);

        term.writeln(
          "\x1b[1;32m✓ Container ready. Press \x1b[1;37mStart Bot\x1b[1;32m to run.\x1b[0m\n"
        );
        setIsBooting(false);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        term.writeln(`\x1b[1;31m✗ Boot failed: ${msg}\x1b[0m`);
        setBootError(msg);
        setIsBooting(false);
      }
    }

    boot();

    return () => {
      cancelled = true;
    };
  }, [files]);

  // ── 3. Start Bot ────────────────────────────────────────────────────────
  const startBot = useCallback(async () => {
    const term = xtermRef.current;
    if (!term || isRunning) return;

    const wc = wcInstance;
    if (!wc) {
      term.writeln("\x1b[1;31m✗ WebContainer not ready.\x1b[0m");
      return;
    }

    setIsRunning(true);
    term.clear();

    // ── npm install ──────────────────────────────────────────────────────
    term.writeln("\x1b[1;36m◆ Running npm install…\x1b[0m");

    const install = await wc.spawn("npm", ["install"]);
    install.output.pipeTo(
      new WritableStream({ write: (chunk) => term.write(chunk) })
    );
    const installCode = await install.exit;

    if (installCode !== 0) {
      term.writeln("\x1b[1;31m✗ npm install failed.\x1b[0m");
      setIsRunning(false);
      return;
    }

    term.writeln("\n\x1b[1;32m✓ Dependencies installed.\x1b[0m");

    // ── Determine entry point + runner ───────────────────────────────────
    const hasPackageJson = files.some((f) => f.filepath === "package.json");
    const hasIndexTs = files.some((f) => f.filepath === "src/index.ts");
    const hasIndexJs = files.some((f) => f.filepath === "src/index.js");

    let cmd: string;
    let args: string[];

    if (hasPackageJson) {
      // Use the "start" script from package.json if available
      cmd = "npm";
      args = ["start"];
    } else if (hasIndexTs) {
      cmd = "npx";
      args = ["tsx", "src/index.ts"];
    } else if (hasIndexJs) {
      cmd = "node";
      args = ["src/index.js"];
    } else {
      term.writeln("\x1b[1;31m✗ No entry point found (src/index.ts or package.json).\x1b[0m");
      setIsRunning(false);
      return;
    }

    term.writeln(`\x1b[1;36m◆ Starting: ${cmd} ${args.join(" ")}\x1b[0m\n`);

    const runProc = await wc.spawn(cmd, args);
    processRef.current = runProc;

    runProc.output.pipeTo(
      new WritableStream({ write: (chunk) => term.write(chunk) })
    );

    runProc.exit.then((code) => {
      term.writeln(
        `\n\x1b[1;33m◆ Process exited with code ${code}\x1b[0m`
      );
      setIsRunning(false);
      processRef.current = null;
    });
  }, [files, isRunning]);

  // ── 4. Stop Bot ─────────────────────────────────────────────────────────
  const stopBot = useCallback(() => {
    if (processRef.current) {
      processRef.current.kill();
      xtermRef.current?.writeln("\n\x1b[1;31m◆ Stopped by user.\x1b[0m");
      setIsRunning(false);
      processRef.current = null;
    }
  }, []);

  const activeContent = files.find((f) => f.filepath === selectedFile)?.content;

  return (
    <div className="flex flex-col h-screen bg-background overflow-hidden">
      {/* ── Header ── */}
      <div className="flex-shrink-0 bg-background border-b border-border px-6 py-3 flex items-center justify-between z-10">
        <div className="flex items-center gap-4">
          <Link href={`/dashboard/agents/${agentId}`}>
            <Button
              variant="ghost"
              size="sm"
              className="h-8 text-muted-foreground hover:text-foreground"
            >
              <ChevronLeft size={16} className="mr-1" /> Back
            </Button>
          </Link>
          <div className="h-4 w-[1px] bg-border" />
          <div className="flex items-center gap-2">
            <TerminalSquare size={16} className="text-cyan-500" />
            <h1 className="text-sm font-semibold tracking-wide">
              WebContainer IDE
            </h1>
            <span className="text-xs text-muted-foreground bg-muted px-2 py-0.5 rounded-md ml-2">
              {agentId.slice(0, 8)}
            </span>
          </div>
        </div>

        <div className="flex items-center gap-2">
          {isBooting && (
            <span className="text-xs text-amber-400 flex items-center gap-1">
              <Loader2 size={12} className="animate-spin" />
              Booting container…
            </span>
          )}
          {bootError && (
            <span className="text-xs text-red-400">Boot failed</span>
          )}
          {isRunning ? (
            <Button variant="destructive" size="sm" onClick={stopBot}>
              <Square size={13} className="mr-1.5 fill-current" />
              Stop Bot
            </Button>
          ) : (
            <Button
              size="sm"
              onClick={startBot}
              disabled={isBooting || !!bootError || files.length === 0}
              className="bg-cyan-500 hover:bg-cyan-400 text-black font-semibold"
            >
              {isBooting ? (
                <Loader2 size={13} className="animate-spin mr-1.5" />
              ) : (
                <Play size={13} className="mr-1.5 fill-current" />
              )}
              {isBooting ? "Booting…" : "Start Bot"}
            </Button>
          )}
        </div>
      </div>

      {/* ── Main Layout ── */}
      <div className="flex-1 flex overflow-hidden">
        {/* File Explorer */}
        <div className="w-60 flex-shrink-0 bg-[#06080c] border-r border-border flex flex-col">
          <div className="px-4 py-3 border-b border-border/50 text-xs font-semibold text-muted-foreground uppercase tracking-wider">
            Explorer
          </div>
          <div className="flex-1 overflow-y-auto py-2">
            {files.length === 0 ? (
              <div className="px-4 text-xs text-muted-foreground/50 mt-2">
                Loading files…
              </div>
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
                  <FileCode
                    size={13}
                    className={
                      selectedFile === file.filepath
                        ? "text-cyan-400"
                        : "text-slate-500"
                    }
                  />
                  <span className="truncate">{file.filepath}</span>
                </button>
              ))
            )}
          </div>
        </div>

        {/* Editor + Terminal */}
        <div className="flex-1 flex flex-col min-w-0">
          <PanelGroup direction="vertical">
            {/* Code Editor */}
            <Panel defaultSize={60} minSize={20}>
              <div className="h-full flex flex-col bg-[#0a0d14]">
                <div className="bg-[#06080c] border-b border-border/50 flex text-xs">
                  {selectedFile && (
                    <div className="px-4 py-2 border-r border-border/50 bg-[#0a0d14] text-cyan-400 flex items-center gap-2">
                      <FileCode size={12} />
                      {selectedFile}
                    </div>
                  )}
                </div>
                <div className="flex-1 relative overflow-hidden">
                  <CodeEditor content={activeContent ?? "// Select a file"} />
                </div>
              </div>
            </Panel>

            <PanelResizeHandle className="h-1.5 bg-border/50 hover:bg-cyan-500/50 transition-colors cursor-row-resize" />

            {/* xterm.js Terminal */}
            <Panel defaultSize={40} minSize={15}>
              <div className="h-full flex flex-col">
                <div className="bg-[#06080c] border-b border-border/50 px-4 py-2 flex items-center justify-between">
                  <div className="flex items-center gap-2 text-xs font-semibold text-muted-foreground uppercase tracking-wider">
                    <TerminalSquare size={13} />
                    WebContainer Terminal
                    {isRunning && (
                      <span className="flex items-center gap-1 text-green-400 normal-case font-normal ml-2">
                        <span className="w-1.5 h-1.5 rounded-full bg-green-400 animate-pulse" />
                        running
                      </span>
                    )}
                  </div>
                </div>
                {/* xterm mounts here */}
                <div
                  ref={terminalDivRef}
                  className="flex-1 overflow-hidden p-1"
                  style={{ background: "#0a0d14" }}
                />
              </div>
            </Panel>
          </PanelGroup>
        </div>
      </div>
    </div>
  );
}