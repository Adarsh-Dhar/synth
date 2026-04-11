import { spawn, exec, ChildProcess } from "child_process";
import { promisify } from "util";
import * as fs from "fs/promises";
import * as path from "path";
import prisma from "./lib/prisma.js";
import { decryptEnvConfig } from "./crypto-env.js";

const execAsync = promisify(exec);

// ── In-memory state ───────────────────────────────────────────────────────────

const runningAgents: Map<string, ChildProcess> = new Map();

// Circular log buffer — keeps last 500 lines per agent
const MAX_LOG_LINES = 500;

interface LogEntry {
  line:  string;
  level: "stdout" | "stderr";
  ts:    number; // epoch ms
}

const agentLogs: Map<string, LogEntry[]> = new Map();

function appendLog(agentId: string, line: string, level: "stdout" | "stderr") {
  if (!agentLogs.has(agentId)) agentLogs.set(agentId, []);
  const buf = agentLogs.get(agentId)!;
  buf.push({ line, level, ts: Date.now() });
  if (buf.length > MAX_LOG_LINES) buf.splice(0, buf.length - MAX_LOG_LINES);
}

/** Returns log entries for an agent, optionally filtering to entries after `since` (epoch ms). */
export function getAgentLogs(agentId: string, since?: number): LogEntry[] {
  const buf = agentLogs.get(agentId) ?? [];
  return since ? buf.filter((e) => e.ts > since) : [...buf];
}

export function clearAgentLogs(agentId: string) {
  agentLogs.delete(agentId);
}

// ── Core operations ───────────────────────────────────────────────────────────

export async function startAgent({
  agentId,
  files,
  configuration,
  onExit,
}: {
  agentId: string;
  files: Array<{ filepath: string; content: string }>;
  configuration: Record<string, unknown> | null;
  onExit?: (code: number | null) => void;
}) {
  if (runningAgents.has(agentId)) {
    throw new Error(`Agent ${agentId} is already running`);
  }

  // Build workspace
  const workspaceDir = path.join(process.cwd(), ".workspaces", agentId);
  await fs.mkdir(workspaceDir, { recursive: true });

  appendLog(agentId, `Rebuilding workspace from ${files.length} file(s)...`, "stdout");

  for (const file of files) {
    const fullPath = path.join(workspaceDir, file.filepath);
    await fs.mkdir(path.dirname(fullPath), { recursive: true });
    await fs.writeFile(fullPath, file.content, "utf-8");
    appendLog(agentId, `  wrote: ${file.filepath}`, "stdout");
  }

  await prisma.agent.update({
    where: { id: agentId },
    data:  { status: "STARTING" },
  });

  try {
    // ── Decrypt encryptedEnv from configuration ──────────────────────────────
    let decryptedEnv: Record<string, string> = {};

    const encryptedEnv = configuration?.encryptedEnv;
    if (typeof encryptedEnv === "string" && encryptedEnv.trim().length > 0) {
      try {
        decryptedEnv = decryptEnvConfig(encryptedEnv);
        appendLog(
          agentId,
          `Decrypted ${Object.keys(decryptedEnv).length} env var(s) from encryptedEnv.`,
          "stdout"
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        appendLog(agentId, `WARNING: Failed to decrypt encryptedEnv — ${msg}`, "stderr");
        console.error(`[engine] decrypt error for agent ${agentId}:`, err);
        // Don't throw — let the bot start so the error surfaces in its own logs
      }
    } else {
      appendLog(
        agentId,
        "WARNING: No encryptedEnv found in configuration — API keys will be missing.",
        "stderr"
      );
    }

    // Write a .env file so dotenv picks up the vars at boot
    const envFileContent = Object.entries(decryptedEnv)
      .map(([k, v]) => `${k}=${v}`)
      .join("\n");
    await fs.writeFile(path.join(workspaceDir, ".env"), envFileContent, "utf-8");

    appendLog(agentId, "Running npm install...", "stdout");
    await execAsync("npm install --legacy-peer-deps", { cwd: workspaceDir });
    appendLog(agentId, "npm install complete.", "stdout");

    // Merge decrypted vars into the child process environment
    const agentEnv: NodeJS.ProcessEnv = {
      ...process.env,   // inherit PATH, NODE_PATH, etc.
      ...decryptedEnv,  // overlay decrypted API keys (takes full precedence)
    };

    appendLog(agentId, "Spawning tsx src/index.ts...", "stdout");

    const botProcess = spawn("npx", ["tsx", "src/index.ts"], {
      cwd:   workspaceDir,
      env:   agentEnv,
      shell: false,
    });

    runningAgents.set(agentId, botProcess);

    await prisma.agent.update({
      where: { id: agentId },
      data:  { status: "RUNNING" },
    });

    appendLog(agentId, "Agent RUNNING.", "stdout");

    botProcess.stdout?.on("data", (data: Buffer) => {
      const text = data.toString().trimEnd();
      console.log(`[Agent ${agentId} OUT] ${text}`);
      for (const line of text.split("\n")) {
        if (line.trim()) appendLog(agentId, line, "stdout");
      }
    });

    botProcess.stderr?.on("data", (data: Buffer) => {
      const text = data.toString().trimEnd();
      console.error(`[Agent ${agentId} ERR] ${text}`);
      for (const line of text.split("\n")) {
        if (line.trim()) appendLog(agentId, line, "stderr");
      }
    });

    botProcess.on("close", async (code) => {
      const msg = `Process exited with code ${code}`;
      appendLog(agentId, msg, code === 0 ? "stdout" : "stderr");
      runningAgents.delete(agentId);

      try {
        await prisma.agent.update({
          where: { id: agentId },
          data:  { status: code === 0 ? "STOPPED" : "ERROR" },
        });
      } catch { /* agent may have been deleted */ }
      if (onExit) await onExit(code);
    });

    return { success: true, message: "Agent started successfully" };

  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    appendLog(agentId, `Failed to start: ${msg}`, "stderr");
    runningAgents.delete(agentId);
    await prisma.agent.update({
      where: { id: agentId },
      data:  { status: "ERROR" },
    });
    if (onExit) await onExit(null);
    throw error;
  }
}

export async function stopAgent(agentId: string) {
  const botProcess = runningAgents.get(agentId);

  if (!botProcess) {
    await prisma.agent.update({
      where: { id: agentId },
      data:  { status: "STOPPED" },
    });
    return { success: true, message: "Agent was not running; marked as STOPPED." };
  }

  await prisma.agent.update({
    where: { id: agentId },
    data:  { status: "STOPPING" },
  });

  appendLog(agentId, "SIGTERM sent — stopping agent...", "stdout");
  botProcess.kill("SIGTERM");
  runningAgents.delete(agentId);

  await prisma.agent.update({
    where: { id: agentId },
    data:  { status: "STOPPED" },
  });

  appendLog(agentId, "Agent STOPPED.", "stdout");
  return { success: true, message: "Agent stopped successfully" };
}

export function getAgentStatus(agentId: string) {
  return { agentId, running: runningAgents.has(agentId) };
}

export function listRunningAgents() {
  return Array.from(runningAgents.keys());
}