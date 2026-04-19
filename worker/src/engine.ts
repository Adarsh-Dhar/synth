import prisma from "./lib/prisma.js";
import {
  startAgent as startDockerAgent,
  stopAgent as stopDockerAgent,
  deliverEventToAgent,
  getLogs as getRunnerLogs,
  isAgentRunning,
  listRunningAgentIds,
} from "./agent-runner.js";
import { AgentEventTrigger, GoldRushStreamEvent, GoldRushThreatType } from "./types.js";

// ── In-memory state ───────────────────────────────────────────────────────────

interface LogEntry {
  line:  string;
  level: "stdout" | "stderr";
  ts:    number; // epoch ms
}

const SUPPORTED_EVENT_TYPES: GoldRushThreatType[] = ["lp_pull", "drainer_approval", "phishing_airdrop"];

type GoldRushSubscriptionHandle = {
  stop: () => void;
};

const streamSubscriptions = new Map<string, GoldRushSubscriptionHandle>();

function parseStreamFilters(raw: unknown): GoldRushThreatType[] {
  const source = typeof raw === "string" ? raw : "";
  const filters = source
    .split(",")
    .map((part) => part.trim() as GoldRushThreatType)
    .filter((part) => SUPPORTED_EVENT_TYPES.includes(part));

  return filters.length > 0 ? Array.from(new Set(filters)) : SUPPORTED_EVENT_TYPES;
}

function requireWorkerGoldRushEnv(): { apiKey: string; streamUrl: string; mcpUrl: string } {
  const apiKey = String(process.env.GOLDRUSH_API_KEY || "").trim();
  const streamUrl = String(process.env.GOLDRUSH_STREAM_URL || "").trim();
  const mcpUrl = String(process.env.GOLDRUSH_MCP_URL || "").trim();

  if (!apiKey || !streamUrl || !mcpUrl) {
    throw new Error("Missing required worker GoldRush env vars: GOLDRUSH_API_KEY, GOLDRUSH_STREAM_URL, GOLDRUSH_MCP_URL");
  }

  return { apiKey, streamUrl, mcpUrl };
}

function normalizeEventPayload(agentId: string, raw: unknown): GoldRushStreamEvent | null {
  if (!raw || typeof raw !== "object") return null;
  const src = raw as Record<string, unknown>;

  const typeRaw = String(src.type ?? src.eventType ?? "").trim();
  if (!SUPPORTED_EVENT_TYPES.includes(typeRaw as GoldRushThreatType)) return null;

  const timestampRaw = Number(src.timestamp ?? Date.now());
  const timestamp = Number.isFinite(timestampRaw) ? timestampRaw : Date.now();

  return {
    agentId,
    type: typeRaw as GoldRushThreatType,
    txHash: typeof src.txHash === "string" ? src.txHash : undefined,
    walletAddress: typeof src.walletAddress === "string" ? src.walletAddress : undefined,
    tokenAddress: typeof src.tokenAddress === "string" ? src.tokenAddress : undefined,
    chainId: typeof src.chainId === "string" ? src.chainId : undefined,
    source: typeof src.source === "string" ? src.source : "goldrush-stream",
    riskScore: typeof src.riskScore === "number" ? src.riskScore : undefined,
    details: typeof src.details === "object" && src.details ? (src.details as Record<string, unknown>) : undefined,
    timestamp,
  };
}

async function routeEventToRunningAgent(trigger: AgentEventTrigger): Promise<void> {
  if (!isAgentRunning(trigger.agentId)) {
    throw new Error(`Agent ${trigger.agentId} is not running`);
  }

  const delivery = await deliverEventToAgent(trigger.agentId, trigger.event);
  if (!delivery.ok) {
    throw new Error(delivery.error ?? "Failed to deliver event to agent container");
  }
}

async function startGoldRushSubscription(agentId: string, filters: GoldRushThreatType[]): Promise<void> {
  if (streamSubscriptions.has(agentId)) return;
  const { apiKey, streamUrl } = requireWorkerGoldRushEnv();

  const abortController = new AbortController();
  let active = true;

  const runLoop = async () => {
    while (active) {
      try {
        const url = new URL(streamUrl);
        url.searchParams.set("agentId", agentId);
        for (const filter of filters) {
          url.searchParams.append("eventType", filter);
        }

        const response = await fetch(url.toString(), {
          method: "GET",
          headers: {
            Authorization: `Bearer ${apiKey}`,
            Accept: "text/event-stream",
          },
          signal: abortController.signal,
        });

        if (!response.ok || !response.body) {
          throw new Error(`GoldRush stream request failed (${response.status})`);
        }

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";

        while (active) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });

          let sepIndex = buffer.indexOf("\n\n");
          while (sepIndex !== -1) {
            const chunk = buffer.slice(0, sepIndex);
            buffer = buffer.slice(sepIndex + 2);

            const dataLines = chunk
              .split("\n")
              .filter((line) => line.startsWith("data:"))
              .map((line) => line.slice(5).trim())
              .filter(Boolean);

            for (const payloadLine of dataLines) {
              try {
                const parsed = JSON.parse(payloadLine) as unknown;
                const normalized = normalizeEventPayload(agentId, parsed);
                if (!normalized) continue;

                await routeEventToRunningAgent({
                  agentId,
                  event: normalized,
                  receivedAt: Date.now(),
                });
              } catch (error) {
                console.warn(`[engine] Failed to process GoldRush stream event for ${agentId}:`, error);
              }
            }

            sepIndex = buffer.indexOf("\n\n");
          }
        }
      } catch (error) {
        if (!active) break;
        console.warn(`[engine] GoldRush stream disconnected for ${agentId}; reconnecting`, error);
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
    }
  };

  void runLoop();

  streamSubscriptions.set(agentId, {
    stop: () => {
      active = false;
      abortController.abort();
    },
  });
}

function stopGoldRushSubscription(agentId: string): void {
  const handle = streamSubscriptions.get(agentId);
  if (!handle) return;
  handle.stop();
  streamSubscriptions.delete(agentId);
}

export async function deliverAgentEvent(trigger: AgentEventTrigger): Promise<void> {
  await routeEventToRunningAgent(trigger);
}

export function normalizeAgentEvent(agentId: string, raw: unknown): GoldRushStreamEvent | null {
  return normalizeEventPayload(agentId, raw);
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

async function ensureActiveDodoSubscription(agentId: string): Promise<void> {
  const subscription = await prisma.subscription.findFirst({
    where: { agentId, provider: "dodo" },
    orderBy: { updatedAt: "desc" },
    select: { status: true, validUntil: true },
  });

  if (!subscription) {
    return;
  }

  const isExpired = Boolean(subscription.validUntil && subscription.validUntil.getTime() <= Date.now());
  const isActive = subscription.status.trim().toUpperCase() === "ACTIVE" && !isExpired;
  if (!isActive) {
    throw new Error("Subscription required to start this agent.");
  }
}

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

  await ensureActiveDodoSubscription(agentId);
  requireWorkerGoldRushEnv();

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
        stopGoldRushSubscription(agentId);
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

    const filters = parseStreamFilters(
      configuration?.GOLDRUSH_STREAM_EVENTS ??
      configuration?.goldrushStreamFilter ??
      process.env.GOLDRUSH_STREAM_EVENTS ??
      "",
    );
    await startGoldRushSubscription(agentId, filters);

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

  stopGoldRushSubscription(agentId);

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