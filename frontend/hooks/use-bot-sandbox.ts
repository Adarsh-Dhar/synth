"use client";

import { MutableRefObject, useEffect, useRef, useState } from "react";
import type { Terminal } from "@xterm/xterm";
import type { BotEnvConfig } from "@/lib/bot-constant";
import { BOT_NPMRC } from "@/lib/bot-constant";

export type BotPhase = "idle" | "env-setup" | "running" | "booting" | "installing";

interface BotFile {
  filepath: string;
  content: string;
}

interface UseBotSandboxOptions {
  generatedFiles: BotFile[];
  envConfig: BotEnvConfig;
  termRef: MutableRefObject<Terminal | null>;
}

let globalWC: unknown = null;

function normalizeEnvValue(raw: string): string {
  const trimmed = raw.trim().replace(/\r/g, "");
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function buildEnvFileContent(cfg: BotEnvConfig): string {
  const merged: Record<string, string> = {};
  for (const [k, v] of Object.entries(cfg)) {
    if (k === "SOLANA_KEY" || k === "SOLANA_KEY") continue;
    if (typeof v === "string" && v !== "") {
      merged[k] = normalizeEnvValue(v);
    }
  }
  if (!merged.SIMULATION_MODE) merged.SIMULATION_MODE = "true";
  if (!merged.SOLANA_NETWORK) merged.SOLANA_NETWORK = "solana-testnet";
  if (!merged.SOLANA_NETWORK) merged.SOLANA_NETWORK = "devnet";
  return Object.entries(merged)
    .map(([k, v]) => `${k}=${v}`)
    .join("\n");
}

function parseFilesToTree(files: BotFile[]): Record<string, unknown> {
  const tree: Record<string, unknown> = {};
  for (const file of files) {
    const path = file.filepath.replace(/^[./]+/, "");
    const parts = path.split("/").filter(Boolean);
    let cur: Record<string, unknown> = tree;
    for (let i = 0; i < parts.length; i += 1) {
      const part = parts[i];
      if (i === parts.length - 1) {
        cur[part] = { file: { contents: file.content } };
      } else {
        if (!cur[part]) cur[part] = { directory: {} };
        cur = (cur[part] as { directory: Record<string, unknown> }).directory;
      }
    }
  }
  return tree;
}

function detectRunStrategy(files: BotFile[]): { needsInstall: boolean; runCmd: string } {
  const cleanPaths = files.map((f) => f.filepath.replace(/^[./]+/, ""));
  const hasPackageJson = cleanPaths.includes("package.json");
  const hasTsIndex = cleanPaths.includes("src/index.ts");
  const hasJsIndex = cleanPaths.includes("src/index.js");
  return {
    needsInstall: hasPackageJson,
    runCmd: hasPackageJson
      ? "npm run start"
      : hasTsIndex
        ? "npx --yes tsx src/index.ts"
        : hasJsIndex
          ? "node src/index.js"
          : "node index.js",
  };
}

function buildProcessEnv(cfg: BotEnvConfig): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(cfg)) {
    if (k === "SOLANA_KEY" || k === "SOLANA_KEY") continue;
    if (typeof v === "string" && v !== "") env[k] = normalizeEnvValue(v);
  }
  if (!env.SIMULATION_MODE) env.SIMULATION_MODE = "true";
  if (!env.MCP_GATEWAY_URL) env.MCP_GATEWAY_URL = "http://localhost:8000/mcp";
  if (!env.SOLANA_NETWORK) env.SOLANA_NETWORK = "devnet";
  if (!env.SOLANA_NETWORK) env.SOLANA_NETWORK = "solana-testnet";
  // Keep RPC discovery compatible
  if (!env.SOLANA_RPC_URL && env.SOLANA_RPC_URL) env.SOLANA_RPC_URL = env.SOLANA_RPC_URL;
  if (!env.SOLANA_RPC_URL && env.SOLANA_RPC_URL) env.SOLANA_RPC_URL = env.SOLANA_RPC_URL;
  return env;
}

export function useBotSandbox({ generatedFiles, envConfig, termRef }: UseBotSandboxOptions) {
  const [phase, setPhase] = useState<BotPhase>("idle");
  const [status, setStatus] = useState("Idle");
  const activeProcessRef = useRef<{ kill(): void } | null>(null);

  useEffect(() => {
    if (generatedFiles.length > 0 && phase === "idle") {
      setPhase("env-setup");
    }
  }, [generatedFiles.length, phase]);

  const stopProcess = async () => {
    if (activeProcessRef.current) {
      activeProcessRef.current.kill();
      activeProcessRef.current = null;
    }
    setPhase("idle");
    setStatus("Stopped");
    termRef.current?.writeln("\x1b[33m[System]\x1b[0m Bot process stopped.");
  };

  const bootAndRun = async (launchEnvConfig?: BotEnvConfig): Promise<void> => {
    const term = termRef.current;
    if (!term) return;

    try {
      setPhase("booting");
      setStatus("Booting sandbox...");
      term.writeln("\x1b[36m[System]\x1b[0m Booting WebContainer...");

      const { WebContainer } = await import("@webcontainer/api");
      const wc = (globalWC as InstanceType<typeof WebContainer> | null) ?? (await WebContainer.boot());
      globalWC = wc;

      const effectiveEnvConfig = launchEnvConfig ?? envConfig;
      const envContent = buildEnvFileContent(effectiveEnvConfig);
      const { needsInstall, runCmd } = detectRunStrategy(generatedFiles);
      const files: BotFile[] = [
        ...generatedFiles.filter((f) => f.filepath !== ".env" && f.filepath !== ".npmrc"),
        { filepath: ".env", content: envContent },
        { filepath: ".npmrc", content: BOT_NPMRC },
      ];

      await wc.mount(parseFilesToTree(files) as any);

      if (needsInstall) {
        setPhase("installing");
        setStatus("Installing dependencies...");
        term.writeln("\x1b[36m[System]\x1b[0m npm install");
        const installProc = await wc.spawn("npm", ["install"]);
        installProc.output.pipeTo(
          new WritableStream({
            write(data) {
              term.write(data);
            },
          }),
        );
        const code = await installProc.exit;
        if (code !== 0) throw new Error(`npm install failed with exit code ${code}`);
      }

      setPhase("running");
      setStatus("Running");
      term.writeln(`\x1b[36m[System]\x1b[0m ${runCmd}`);

      const runProc = await wc.spawn("sh", ["-lc", runCmd], {
        env: buildProcessEnv(effectiveEnvConfig),
      });
      activeProcessRef.current = runProc as unknown as { kill(): void };

      runProc.output.pipeTo(
        new WritableStream({
          write(data) {
            term.write(data);
          },
        }),
      );
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      setPhase("idle");
      setStatus("Error");
      term.writeln(`\x1b[31m[Error]\x1b[0m ${msg}`);
    }
  };

  return {
    phase,
    setPhase,
    status,
    stopProcess,
    bootAndRun,
  };
}
