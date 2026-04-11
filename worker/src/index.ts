/**
 * worker/src/index.ts
 *
 * Agentia Worker — lightweight HTTP server.
 *
 * Endpoints:
 *   POST /agents/:id/start  → fetch agent from DB, decrypt env, spawn process
 *   POST /agents/:id/stop   → SIGTERM the process
 *   GET  /agents/:id/logs   → poll log buffer (accepts ?since=<epoch_ms>)
 *   GET  /health            → liveness check
 */

import "dotenv/config";
import http from "http";
import { URL } from "url";
import prisma from "./lib/prisma.js";
import {
  startAgent,
  stopAgent,
  getAgentLogs,
  getAgentStatus,
} from "./engine.js";

// ── Config ────────────────────────────────────────────────────────────────────

const PORT = parseInt(process.env.PORT ?? "4001", 10);
const WORKER_SECRET = process.env.WORKER_SECRET ?? "dev-worker-secret";
const FRONTEND_URL = process.env.FRONTEND_URL ?? "http://localhost:3000";

// ── Auth ──────────────────────────────────────────────────────────────────────

function isAuthorized(req: http.IncomingMessage): boolean {
  const auth = req.headers["authorization"] ?? "";
  return auth === `Bearer ${WORKER_SECRET}`;
}

// ── JSON helpers ──────────────────────────────────────────────────────────────

function json(res: http.ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(payload);
}

function readBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => (data += chunk));
    req.on("end", () => {
      try {
        resolve(data.trim() ? JSON.parse(data) : {});
      } catch {
        reject(new Error("Invalid JSON body"));
      }
    });
    req.on("error", reject);
  });
}

// ── DB status helpers ─────────────────────────────────────────────────────────

async function setAgentStatus(
  agentId: string,
  status: "STARTING" | "RUNNING" | "STOPPING" | "STOPPED" | "ERROR"
): Promise<void> {
  await fetch(`${FRONTEND_URL}/api/agents/${agentId}/status`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ status }),
  }).catch((err) => console.error(`[Worker] Status update failed for ${agentId}:`, err));
}

// ── Router ────────────────────────────────────────────────────────────────────

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);
  const pathname = url.pathname;

  // Health check — no auth required
  if (req.method === "GET" && pathname === "/health") {
    return json(res, 200, { ok: true, running: [...(require("./agent-runner") as { running?: Map<string, unknown> }).running?.keys() ?? []] });
  }

  // All other routes require auth
  if (!isAuthorized(req)) {
    return json(res, 401, { error: "Unauthorized" });
  }

  // POST /agents/:id/start
  const startMatch = pathname.match(/^\/agents\/([^/]+)\/start$/);
  if (req.method === "POST" && startMatch) {
    const agentId = startMatch[1];

    if (getAgentStatus(agentId).running) {
      return json(res, 409, { error: "Agent is already running" });
    }

    try {
      // Fetch agent + files from the frontend DB via its own API
      const agentRes = await fetch(`${FRONTEND_URL}/api/agents/${agentId}`, {
        headers: { Authorization: `Bearer ${WORKER_SECRET}` },
      });
      if (!agentRes.ok) {
        return json(res, 404, { error: `Agent ${agentId} not found` });
      }

      const agentData = (await agentRes.json()) as {
        configuration: Record<string, unknown> | null;
        files: Array<{ filepath: string; content: string }>;
      };

      if (!agentData.files?.length) {
        return json(res, 400, { error: "Agent has no files — save bot files first" });
      }

      // Optimistically mark as STARTING in DB
      await setAgentStatus(agentId, "STARTING");

      // Kick off the agent (async — don't await so HTTP responds immediately)
      startAgent({
        agentId,
        files: agentData.files,
        configuration: agentData.configuration,
        onExit: async (code) => {
          const status = code === 0 || code === null ? "STOPPED" : "ERROR";
          await setAgentStatus(agentId, status);
        },
      })
        .then(async () => {
          await setAgentStatus(agentId, "RUNNING");
        })
        .catch(async (err: Error) => {
          console.error(`[Worker] Failed to start agent ${agentId}:`, err);
          await setAgentStatus(agentId, "ERROR");
        });

      return json(res, 200, { ok: true, agentId, status: "STARTING" });
    } catch (err) {
      console.error(`[Worker] start error for ${agentId}:`, err);
      return json(res, 500, { error: String(err) });
    }
  }

  // POST /agents/:id/stop
  const stopMatch = pathname.match(/^\/agents\/([^/]+)\/stop$/);
  if (req.method === "POST" && stopMatch) {
    const agentId = stopMatch[1];

    if (!getAgentStatus(agentId).running) {
      return json(res, 404, { error: "Agent is not running" });
    }

    await setAgentStatus(agentId, "STOPPING");
    const stopped = stopAgent(agentId);
    return json(res, 200, { ok: stopped, agentId });
  }

  // GET /agents/:id/logs?since=<epoch_ms>
  const logsMatch = pathname.match(/^\/agents\/([^/]+)\/logs$/);
  if (req.method === "GET" && logsMatch) {
    const agentId = logsMatch[1];
    const since = url.searchParams.get("since");
    const sinceMs = since ? parseInt(since, 10) : undefined;
    const entries = getAgentLogs(agentId, sinceMs);
    return json(res, 200, { agentId, entries });
  }

  return json(res, 404, { error: "Not found" });
});

// ── Startup ───────────────────────────────────────────────────────────────────

async function main() {
  console.log("🚀 Agentia Worker starting...");
  console.log(`   Port : ${PORT}`);
  console.log(`   Env  : ${process.env.NODE_ENV ?? "development"}`);

  try {
    await prisma.$connect();
    console.log("✅ Database connected");
  } catch (err) {
    console.error("❌ Database connection failed:", err);
    process.exit(1);
  }

  // Reset any agents left in STARTING/STOPPING state from a previous crash
  const stale = await prisma.agent.updateMany({
    where: { status: { in: ["STARTING", "STOPPING", "RUNNING"] } },
    data: { status: "STOPPED" },
  });
  if (stale.count > 0) {
    console.log(`⚠️  Reset ${stale.count} stale agent(s) to STOPPED`);
  }

  server.listen(PORT, () => {
    console.log(`🌐 Worker HTTP server listening on port ${PORT}`);
  });
}

// ── Shutdown ──────────────────────────────────────────────────────────────────

function shutdown(signal: string) {
  console.log(`\n🛑 Received ${signal}. Shutting down...`);
  server.close(async () => {
    await prisma.$disconnect();
    console.log("👋 Worker stopped.");
    process.exit(0);
  });
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

main().catch((err) => {
  console.error("Fatal worker error:", err);
  process.exit(1);
});