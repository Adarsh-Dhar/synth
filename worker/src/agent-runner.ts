/**
 * worker/src/agent-runner.ts
 *
 * Runs each agent bot inside an isolated Docker container.
 * No untrusted bot code is executed directly on the worker host process.
 */

import Docker, { Container } from "dockerode";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { PassThrough } from "stream";
import { decryptEnvConfig } from "./crypto-env.js";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface LogEntry {
  line: string;
  level: "stdout" | "stderr";
  ts: number; // epoch ms
}

export interface RunningAgent {
  agentId: string;
  container: Container;
  containerId: string;
  workDir: string;
  logs: LogEntry[];
  startedAt: number;
}

// ── In-memory registry ────────────────────────────────────────────────────────

const running = new Map<string, RunningAgent>();
const docker = new Docker({
  socketPath: process.env.DOCKER_SOCKET_PATH ?? "/var/run/docker.sock",
});

const DOCKER_IMAGE = process.env.AGENT_DOCKER_IMAGE ?? "node:20-alpine";
const DOCKER_MEMORY_BYTES = parseInt(process.env.AGENT_DOCKER_MEMORY_BYTES ?? "536870912", 10);
const DOCKER_NANO_CPUS = parseInt(process.env.AGENT_DOCKER_NANO_CPUS ?? "1000000000", 10);

const MAX_LOG_LINES = 2000;

function listEnvPairs(env: Record<string, string>): string[] {
  return Object.entries(env).map(([k, v]) => `${k}=${v}`);
}

function safeResolveUnder(root: string, filePath: string): string {
  const cleanRel = filePath.replace(/^\.\//, "");
  const resolved = path.resolve(root, cleanRel);
  const normalizedRoot = path.resolve(root) + path.sep;
  if (!resolved.startsWith(normalizedRoot) && resolved !== path.resolve(root)) {
    throw new Error(`Invalid file path outside workspace: ${filePath}`);
  }
  return resolved;
}

async function ensureDockerImage(image: string): Promise<void> {
  try {
    await docker.getImage(image).inspect();
    return;
  } catch {
    // pull if missing
  }

  const stream = await docker.pull(image);
  await new Promise<void>((resolve, reject) => {
    docker.modem.followProgress(stream, (err) => {
      if (err) reject(err);
      else resolve();
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
    "index.js",
  ];
  for (const c of candidates) {
    if (files.some((f) => f.filepath === c || f.filepath === `./${c}`)) {
      return c;
    }
  }
  const fallback = files.find((f) => f.filepath.endsWith(".ts") || f.filepath.endsWith(".js"));
  return fallback?.filepath ?? "src/index.ts";
}

function buildContainerCommand(files: Array<{ filepath: string }>, entryPoint: string): string {
  const hasPackageJson = files.some((f) => f.filepath === "package.json" || f.filepath === "./package.json");
  if (hasPackageJson) {
    return `npm install --legacy-peer-deps --no-fund --loglevel=error && npx tsx ${entryPoint}`;
  }
  return `npm install --no-package-lock --no-fund --loglevel=error tsx typescript @types/node && npx tsx ${entryPoint}`;
}

function pushLine(logBuffer: LogEntry[], line: string, level: "stdout" | "stderr") {
  if (!line) return;
  logBuffer.push({ line, level, ts: Date.now() });
  if (logBuffer.length > MAX_LOG_LINES) {
    logBuffer.splice(0, logBuffer.length - MAX_LOG_LINES);
  }
}

function wireStreamLines(
  stream: NodeJS.ReadableStream,
  level: "stdout" | "stderr",
  onLine: (line: string, level: "stdout" | "stderr") => void,
) {
  let buf = "";
  stream.on("data", (chunk: Buffer | string) => {
    buf += chunk.toString();
    const lines = buf.split("\n");
    buf = lines.pop() ?? "";
    for (const line of lines) {
      if (line.trim()) onLine(line, level);
    }
  });
  stream.on("end", () => {
    if (buf.trim()) onLine(buf, level);
  });
}

export function listRunningAgentIds(): string[] {
  return Array.from(running.keys());
}

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

  await docker.ping();
  await ensureDockerImage(DOCKER_IMAGE);

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
    const filePath = safeResolveUnder(workDir, file.filepath);
    const dir = path.dirname(filePath);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(filePath, file.content, "utf8");
  }

  // Write a .env file from decrypted vars (dotenv loads it at boot)
  const envFileLines = Object.entries(decryptedEnv)
    .map(([k, v]) => `${k}=${v}`)
    .join("\n");
  fs.writeFileSync(path.join(workDir, ".env"), envFileLines, "utf8");

  // ── 3. Determine entry point and container command ────────────────────────
  const entryPoint = resolveEntryPoint(files);
  const runCommand = buildContainerCommand(files, entryPoint);
  console.log(`[AgentRunner] Entry point: ${entryPoint}`);

  // ── 4. Start isolated container ────────────────────────────────────────────
  const childEnv: NodeJS.ProcessEnv = {
    ...decryptedEnv,
    NODE_ENV: "production",
  };

  const container = await docker.createContainer({
    Image: DOCKER_IMAGE,
    Cmd: ["sh", "-lc", runCommand],
    WorkingDir: "/workspace",
    Env: listEnvPairs(childEnv as Record<string, string>),
    AttachStdout: true,
    AttachStderr: true,
    Tty: false,
    HostConfig: {
      AutoRemove: true,
      Binds: [`${workDir}:/workspace`],
      ReadonlyRootfs: true,
      Memory: DOCKER_MEMORY_BYTES,
      NanoCpus: DOCKER_NANO_CPUS,
      NetworkMode: process.env.AGENT_DOCKER_NETWORK_MODE ?? "bridge",
      CapDrop: ["ALL"],
      SecurityOpt: ["no-new-privileges"],
      PidsLimit: parseInt(process.env.AGENT_DOCKER_PIDS_LIMIT ?? "256", 10),
    },
    User: process.env.AGENT_DOCKER_USER ?? "node",
  });

  const logBuffer: LogEntry[] = [];

  await container.start();

  const stream = await container.logs({
    follow: true,
    stdout: true,
    stderr: true,
    timestamps: false,
  });

  const stdoutStream = new PassThrough();
  const stderrStream = new PassThrough();
  docker.modem.demuxStream(stream, stdoutStream, stderrStream);

  wireStreamLines(stdoutStream, "stdout", (line, level) => {
    pushLine(logBuffer, line, level);
    console.log(`[Agent ${agentId} OUT] ${line}`);
  });
  wireStreamLines(stderrStream, "stderr", (line, level) => {
    pushLine(logBuffer, line, level);
    console.error(`[Agent ${agentId} ERR] ${line}`);
  });

  container.wait().then((result) => {
    const code = result.StatusCode ?? null;
    console.log(`[AgentRunner] Agent ${agentId} container exited with code ${code}`);
    running.delete(agentId);
    try {
      fs.rmSync(workDir, { recursive: true, force: true });
    } catch {
      // Best-effort cleanup
    }
    onExit?.(code);
  }).catch((err) => {
    pushLine(logBuffer, `Container wait failed: ${err instanceof Error ? err.message : String(err)}`, "stderr");
    running.delete(agentId);
    try {
      fs.rmSync(workDir, { recursive: true, force: true });
    } catch {
      // Best-effort cleanup
    }
    onExit?.(1);
  });

  const entry: RunningAgent = {
    agentId,
    container,
    containerId: container.id,
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

  agent.container.stop({ t: 5 }).catch(async () => {
    try {
      await agent.container.kill();
    } catch {
      // Container may already be gone
    }
  });

  return true;
}