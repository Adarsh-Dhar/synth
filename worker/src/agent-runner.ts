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
import { GoldRushStreamEvent } from "./types.js";

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
const DOCKER_MEMORY_BYTES = 256 * 1024 * 1024;
const DOCKER_MEMORY_SWAP_BYTES = 256 * 1024 * 1024;
const DOCKER_CPU_QUOTA = 50000;
const DOCKER_CPU_PERIOD = 100000;
const DOCKER_PIDS_LIMIT = parseInt(process.env.AGENT_DOCKER_PIDS_LIMIT ?? "256", 10);

const MAX_LOG_LINES = 2000;

export type EventDeliveryResult = {
  ok: boolean;
  error?: string;
};

function listEnvPairs(env: Record<string, string>): string[] {
  return Object.entries(env).map(([k, v]) => `${k}=${v}`);
}

function resolveHostFromUrl(rawUrl: string | undefined): string | null {
  if (!rawUrl) return null;
  try {
    const parsed = new URL(rawUrl);
    return parsed.hostname || null;
  } catch {
    return null;
  }
}

function resolveAllowlistedDomains(goldrushMcpUrl: string): string {
  const configured = String(process.env.AGENT_DOCKER_ALLOWED_OUTBOUND_DOMAINS ?? "")
    .split(",")
    .map((d) => d.trim())
    .filter(Boolean);

  const mcpHost = resolveHostFromUrl(goldrushMcpUrl);
  if (mcpHost) configured.push(mcpHost);

  return Array.from(new Set(configured)).join(",");
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
    return `npm install --legacy-peer-deps --no-fund --loglevel=error --no-save tsx && node /workspace/.agent-launcher.mjs`;
  }
  return `npm install --no-package-lock --no-fund --loglevel=error tsx typescript @types/node && node /workspace/.agent-launcher.mjs`;
}

function buildLauncherScript(entryPoint: string): string {
  return `import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

const entryPoint = ${JSON.stringify(entryPoint)};

const child = spawn(process.execPath, ["--import", "tsx", entryPoint], {
  cwd: "/workspace",
  env: process.env,
  stdio: ["ignore", "pipe", "pipe", "ipc"],
});

child.stdout.on("data", (chunk) => {
  process.stdout.write(chunk);
});

child.stderr.on("data", (chunk) => {
  process.stderr.write(chunk);
});

child.on("error", (error) => {
  process.stderr.write("[launcher] child error: " + (error instanceof Error ? error.stack ?? error.message : String(error)) + "\n");
  process.exit(1);
});

child.on("exit", (code, signal) => {
  if (signal) {
    process.exit(1);
    return;
  }
  process.exit(code ?? 1);
});

const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
input.on("line", (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  try {
    const payload = JSON.parse(trimmed);
    if (!child.send(payload)) {
      process.stderr.write("[launcher] child IPC channel closed\n");
    }
  } catch (error) {
    process.stderr.write("[launcher] invalid payload: " + (error instanceof Error ? error.message : String(error)) + "\n");
  }
});

const relaySignal = (signal: NodeJS.Signals) => {
  if (!child.killed) {
    child.kill(signal);
  }
};

process.on("SIGINT", () => relaySignal("SIGINT"));
process.on("SIGTERM", () => relaySignal("SIGTERM"));

process.stdin.resume();
`.replace(/^\n/, "");
}

function writeLauncherFile(workDir: string, entryPoint: string): string {
  const launcherPath = path.join(workDir, ".agent-launcher.mjs");
  fs.writeFileSync(launcherPath, buildLauncherScript(entryPoint), "utf8");
  return launcherPath;
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

async function waitForExecExit(container: Container, execId: string): Promise<number> {
  for (let i = 0; i < 60; i += 1) {
    const inspect = await container.getExec(execId).inspect();
    if (!inspect.Running) {
      return inspect.ExitCode ?? 1;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return 1;
}

async function deliverPayloadToRunningAgent(
  agentId: string,
  payload: unknown,
): Promise<EventDeliveryResult> {
  const agent = running.get(agentId);
  if (!agent) {
    return { ok: false, error: `Agent ${agentId} is not running` };
  }

  const serialized = JSON.stringify(payload);
  if (serialized == null) {
    return { ok: false, error: "Payload is not JSON serializable" };
  }

  const payloadB64 = Buffer.from(serialized, "utf8").toString("base64");
  const exec = await agent.container.exec({
    AttachStdout: true,
    AttachStderr: true,
    AttachStdin: false,
    Cmd: [
      "sh",
      "-lc",
      "node -e \"process.stdout.write(Buffer.from(process.env.EVENT_PAYLOAD_B64 || '', 'base64').toString('utf8'))\" > /proc/1/fd/0",
    ],
    Env: [`EVENT_PAYLOAD_B64=${payloadB64}`],
  });

  await exec.start({ Detach: false, Tty: false });
  const exitCode = await waitForExecExit(agent.container, exec.id);
  if (exitCode !== 0) {
    return { ok: false, error: `Event delivery failed with exit code ${exitCode}` };
  }

  return { ok: true };
}

export async function deliverEventToAgent(
  agentId: string,
  event: GoldRushStreamEvent,
): Promise<EventDeliveryResult> {
  return deliverPayloadToRunningAgent(agentId, event);
}

export async function deliverWebhookPayloadToAgent(
  agentId: string,
  payload: unknown,
): Promise<EventDeliveryResult> {
  return deliverPayloadToRunningAgent(agentId, payload);
}

// ── Start ─────────────────────────────────────────────────────────────────────

export interface StartAgentOptions {
  agentId: string;
  /** Files from AgentFile[] */
  files: Array<{ filepath: string; content: string }>;
  /** Raw configuration JSON from the Agent row */
  configuration: Record<string, unknown> | null;
  /** Encrypted env config stored on the Agent row. */
  envConfig?: string | null;
  onExit?: (code: number | null) => void;
}

export async function startAgent(opts: StartAgentOptions): Promise<RunningAgent> {
  const { agentId, files, configuration, envConfig, onExit } = opts;

  if (running.has(agentId)) {
    throw new Error(`Agent ${agentId} is already running`);
  }

  await docker.ping();
  await ensureDockerImage(DOCKER_IMAGE);

  // ── 1. Decrypt env vars ────────────────────────────────────────────────────
  let decryptedEnv: Record<string, string> = {};

  const encryptedEnv = typeof envConfig === "string" && envConfig.trim().length > 0
    ? envConfig
    : configuration?.encryptedEnv;
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

  if (!decryptedEnv.GOLDRUSH_API_KEY) {
    console.warn(`[AgentRunner] Missing decrypted GOLDRUSH_API_KEY for agent ${agentId}`);
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

  const resolvedGoldrushMcpUrl =
    decryptedEnv.GOLDRUSH_MCP_URL ||
    process.env.GOLDRUSH_MCP_URL ||
    "";
  const allowlistedDomains = resolveAllowlistedDomains(resolvedGoldrushMcpUrl);
  const fastFrankfurtRpcUrl = String(process.env.INTERNAL_RPC_FAST_FRANKFURT_URL ?? "").trim();
  if (!fastFrankfurtRpcUrl) {
    throw new Error("Missing required environment variable: INTERNAL_RPC_FAST_FRANKFURT_URL");
  }

  writeLauncherFile(workDir, entryPoint);

  // ── 4. Start isolated container ────────────────────────────────────────────
  const childEnv: NodeJS.ProcessEnv = {
    ...decryptedEnv,
    NODE_ENV: "production",
    SOLANA_RPC_URL: fastFrankfurtRpcUrl,
    SOLANA_NETWORK: "mainnet-beta",
    AGENT_EVENT_ENDPOINT: "http://127.0.0.1:7777/agent-event",
    GOLDRUSH_MCP_URL: resolvedGoldrushMcpUrl,
    AGENT_ALLOWED_OUTBOUND_DOMAINS: allowlistedDomains,
  };

  const container = await docker.createContainer({
    Image: DOCKER_IMAGE,
    Cmd: ["sh", "-lc", runCommand],
    WorkingDir: "/workspace",
    Env: listEnvPairs(childEnv as Record<string, string>),
    AttachStdout: true,
    AttachStdin: true,
    AttachStderr: true,
    Tty: false,
    OpenStdin: true,
    StdinOnce: false,
    HostConfig: {
      AutoRemove: true,
      Binds: [`${workDir}:/workspace`],
      ReadonlyRootfs: true,
      Tmpfs: {
        "/tmp": "rw,size=65536k,nosuid,nodev,noexec",
      },
      Memory: DOCKER_MEMORY_BYTES,
      MemorySwap: DOCKER_MEMORY_SWAP_BYTES,
      CpuQuota: DOCKER_CPU_QUOTA,
      CpuPeriod: DOCKER_CPU_PERIOD,
      NetworkMode: process.env.AGENT_DOCKER_NETWORK_MODE ?? "bridge",
      CapDrop: ["ALL"],
      SecurityOpt: ["no-new-privileges"],
      PidsLimit: DOCKER_PIDS_LIMIT,
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