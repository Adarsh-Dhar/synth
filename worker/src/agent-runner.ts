/**
 * worker/src/agent-runner.ts
 *
 * Spawns an agent's bot as a child process, injecting decrypted env vars.
 *
 * Flow:
 *  1. Fetch agent + files from DB
 *  2. Write files to a temp directory
 *  3. Decrypt configuration.encryptedEnv → env vars
 *  4. npm install (if package.json present)
 *  5. spawn: npx tsx src/index.ts
 *  6. Stream stdout/stderr to in-memory log buffer (polled by dashboard)
 */

import { spawn, ChildProcess } from "child_process";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { decryptEnvConfig } from "./crypto-env.js";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface LogEntry {
  line: string;
  level: "stdout" | "stderr";
  ts: number; // epoch ms
}

export interface RunningAgent {
  agentId: string;
  process: ChildProcess;
  workDir: string;
  logs: LogEntry[];
  startedAt: number;
}

// ── In-memory registry ────────────────────────────────────────────────────────

const running = new Map<string, RunningAgent>();

export function getRunningAgent(agentId: string): RunningAgent | undefined {
  return running.get(agentId);
}

export function isAgentRunning(agentId: string): boolean {
  return running.has(agentId);
}

export function getLogs(agentId: string, since?: number): LogEntry[] {
  const agent = running.get(agentId);
  if (!agent) return [];
  if (since == null) return agent.logs.slice(-500);
  return agent.logs.filter((e) => e.ts > since);
}

// ── Start ─────────────────────────────────────────────────────────────────────

export interface StartAgentOptions {
  agentId: string;
  /** Files from AgentFile[] */
  files: Array<{ filepath: string; content: string }>;
  /** Raw configuration JSON from the Agent row */
  configuration: Record<string, unknown> | null;
  onExit?: (code: number | null) => void;
}

export async function startAgent(opts: StartAgentOptions): Promise<RunningAgent> {
  const { agentId, files, configuration, onExit } = opts;

  if (running.has(agentId)) {
    throw new Error(`Agent ${agentId} is already running`);
  }

  // ── 1. Decrypt env vars ────────────────────────────────────────────────────
  let decryptedEnv: Record<string, string> = {};

  const encryptedEnv = configuration?.encryptedEnv;
  if (typeof encryptedEnv === "string" && encryptedEnv.trim().length > 0) {
    try {
      decryptedEnv = decryptEnvConfig(encryptedEnv);
      console.log(`[AgentRunner] Decrypted ${Object.keys(decryptedEnv).length} env vars for agent ${agentId}`);
    } catch (err) {
      console.error(`[AgentRunner] Failed to decrypt env for agent ${agentId}:`, err);
      // Don't throw — let the bot start and fail with a clear error message
    }
  } else {
    console.warn(`[AgentRunner] No encryptedEnv found for agent ${agentId} — bot will likely fail`);
  }

  // ── 2. Write files to temp dir ─────────────────────────────────────────────
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), `agent-${agentId}-`));
  console.log(`[AgentRunner] Work dir: ${workDir}`);

  for (const file of files) {
    const filePath = path.join(workDir, file.filepath);
    const dir = path.dirname(filePath);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(filePath, file.content, "utf8");
  }

  // Write a .env file from decrypted vars (dotenv loads it at boot)
  const envFileLines = Object.entries(decryptedEnv)
    .map(([k, v]) => `${k}=${v}`)
    .join("\n");
  fs.writeFileSync(path.join(workDir, ".env"), envFileLines, "utf8");

  // ── 3. npm install if package.json is present ──────────────────────────────
  const hasPackageJson = files.some((f) => f.filepath === "package.json" || f.filepath === "./package.json");
  if (hasPackageJson) {
    await npmInstall(workDir, agentId);
  }

  // ── 4. Determine entry point ───────────────────────────────────────────────
  const entryPoint = resolveEntryPoint(files);
  console.log(`[AgentRunner] Entry point: ${entryPoint}`);

  // ── 5. Spawn bot process ───────────────────────────────────────────────────
  const childEnv: NodeJS.ProcessEnv = {
    ...process.env, // inherit PATH etc.
    ...decryptedEnv, // overlay decrypted vars (takes precedence)
    NODE_ENV: "production",
  };

  const child = spawn("npx", ["tsx", entryPoint], {
    cwd: workDir,
    env: childEnv,
    shell: false, // avoid shell injection risk
  });

  const logBuffer: LogEntry[] = [];

  const pushLog = (line: string, level: "stdout" | "stderr") => {
    logBuffer.push({ line, level, ts: Date.now() });
    // Keep last 2000 lines to avoid unbounded memory growth
    if (logBuffer.length > 2000) logBuffer.splice(0, logBuffer.length - 2000);
  };

  // Stream output line by line
  let stdoutBuf = "";
  child.stdout?.on("data", (chunk: Buffer) => {
    stdoutBuf += chunk.toString();
    const lines = stdoutBuf.split("\n");
    stdoutBuf = lines.pop() ?? "";
    lines.forEach((l) => {
      if (l) pushLog(l, "stdout");
      console.log(`[Agent ${agentId} OUT] ${l}`);
    });
  });

  let stderrBuf = "";
  child.stderr?.on("data", (chunk: Buffer) => {
    stderrBuf += chunk.toString();
    const lines = stderrBuf.split("\n");
    stderrBuf = lines.pop() ?? "";
    lines.forEach((l) => {
      if (l) pushLog(l, "stderr");
      console.error(`[Agent ${agentId} ERR] ${l}`);
    });
  });

  child.on("exit", (code) => {
    // Flush remaining buffer
    if (stdoutBuf) pushLog(stdoutBuf, "stdout");
    if (stderrBuf) pushLog(stderrBuf, "stderr");

    console.log(`[AgentRunner] Agent ${agentId} exited with code ${code}`);
    running.delete(agentId);

    // Clean up work dir
    try {
      fs.rmSync(workDir, { recursive: true, force: true });
    } catch {
      // Best-effort cleanup
    }

    onExit?.(code);
  });

  const entry: RunningAgent = {
    agentId,
    process: child,
    workDir,
    logs: logBuffer,
    startedAt: Date.now(),
  };

  running.set(agentId, entry);
  return entry;
}

// ── Stop ──────────────────────────────────────────────────────────────────────

export function stopAgent(agentId: string): boolean {
  const agent = running.get(agentId);
  if (!agent) return false;
  agent.process.kill("SIGTERM");
  // Force-kill after 5 s if still alive
  setTimeout(() => {
    if (running.has(agentId)) {
      agent.process.kill("SIGKILL");
    }
  }, 5000);
  return true;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

async function npmInstall(cwd: string, agentId: string): Promise<void> {
  return new Promise((resolve, reject) => {
    console.log(`[AgentRunner] Running npm install for agent ${agentId}…`);
    const proc = spawn(
      "npm",
      ["install", "--legacy-peer-deps", "--no-fund", "--loglevel=error"],
      { cwd, shell: false }
    );
    proc.stdout?.on("data", (d: Buffer) =>
      console.log(`[Agent ${agentId} INSTALL] ${d.toString().trim()}`)
    );
    proc.stderr?.on("data", (d: Buffer) =>
      console.error(`[Agent ${agentId} INSTALL ERR] ${d.toString().trim()}`)
    );
    proc.on("exit", (code) => {
      if (code === 0) {
        console.log(`[AgentRunner] npm install OK for agent ${agentId}`);
        resolve();
      } else {
        reject(new Error(`npm install failed with exit code ${code}`));
      }
    });
  });
}

function resolveEntryPoint(files: Array<{ filepath: string }>): string {
  const candidates = [
    "src/index.ts",
    "src/main.ts",
    "index.ts",
    "main.ts",
    "src/index.js",
  ];
  for (const c of candidates) {
    if (files.some((f) => f.filepath === c || f.filepath === `./${c}`)) {
      return c;
    }
  }
  // Fall back to first .ts file that isn't a config/type file
  const ts = files.find(
    (f) =>
      f.filepath.endsWith(".ts") &&
      !f.filepath.includes("config") &&
      !f.filepath.includes("types") &&
      !f.filepath.includes(".d.ts")
  );
  return ts?.filepath ?? "src/index.ts";
}