import prisma from "./lib/prisma.js";
import {
  startAgent as startDockerAgent,
  stopAgent as stopDockerAgent,
  getLogs as getRunnerLogs,
  isAgentRunning,
  listRunningAgentIds,
} from "./agent-runner.js";

// ── In-memory state ───────────────────────────────────────────────────────────

interface LogEntry {
  line:  string;
  level: "stdout" | "stderr";
  ts:    number; // epoch ms
}

/** Returns log entries for an agent, optionally filtering to entries after `since` (epoch ms). */
export function getAgentLogs(agentId: string, since?: number): LogEntry[] {
  return getRunnerLogs(agentId, since);
}

export function clearAgentLogs(agentId: string) {
  // no-op for now: logs are in the runner's in-memory state
  void agentId;
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
  if (isAgentRunning(agentId)) {
    throw new Error(`Agent ${agentId} is already running`);
  }

  await prisma.agent.update({
    where: { id: agentId },
    data:  { status: "STARTING" },
  });

  try {
    await startDockerAgent({
      agentId,
      files,
      configuration,
      onExit: async (code) => {
        try {
          await prisma.agent.update({
            where: { id: agentId },
            data: { status: code === 0 ? "STOPPED" : "ERROR" },
          });
        } catch {
          // agent may have been deleted
        }
        if (onExit) await onExit(code);
      },
    });

    await prisma.agent.update({
      where: { id: agentId },
      data:  { status: "RUNNING" },
    });

    return { success: true, message: "Agent started successfully" };

  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    await prisma.agent.update({
      where: { id: agentId },
      data:  { status: "ERROR" },
    });
    if (onExit) await onExit(null);
    throw error;
  }
}

export async function stopAgent(agentId: string) {
  if (!isAgentRunning(agentId)) {
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

  stopDockerAgent(agentId);

  await prisma.agent.update({
    where: { id: agentId },
    data:  { status: "STOPPED" },
  });

  return { success: true, message: "Agent stopped successfully" };
}

export function getAgentStatus(agentId: string) {
  return { agentId, running: isAgentRunning(agentId) };
}

export function listRunningAgents() {
  return listRunningAgentIds();
}