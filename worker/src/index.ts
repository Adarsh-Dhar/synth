/**
 * worker/src/index.ts
 *
 * Agentia Worker — entry point.
 *
 * Starts the Express HTTP server (server.ts) and connects to the database.
 * All agent lifecycle logic lives in engine.ts.
 * All HTTP routing lives in server.ts.
 *
 * Endpoints (see server.ts for full details):
 *   POST /agents/:id/start  → write files, decrypt env, spawn process
 *   POST /agents/:id/stop   → SIGTERM the process
 *   GET  /agents/:id/logs   → poll log buffer (?since=<epoch_ms>)
 *   GET  /agents/:id/status → running / stopped
 *   GET  /health            → liveness check
 */

import "dotenv/config";
import prisma from "./lib/prisma.js";
import { startServer } from "./server.js";
import { listRunningAgents } from "./engine.js";

// ── Config ────────────────────────────────────────────────────────────────────

const PORT = parseInt(process.env.PORT ?? "4001", 10);

// ── Startup ───────────────────────────────────────────────────────────────────

async function main() {
  console.log("🚀 Agentia Worker starting…");
  console.log(`   Port : ${PORT}`);
  console.log(`   Env  : ${process.env.NODE_ENV ?? "development"}`);

  // Connect to database
  try {
    await prisma.$connect();
    console.log("✅ Database connected");
  } catch (err) {
    console.error("❌ Database connection failed:", err);
    process.exit(1);
  }

  // Reset agents that were left in a transitional state from a previous crash.
  // These states imply a process was running that no longer exists.
  try {
    const stale = await prisma.agent.updateMany({
      where: { status: { in: ["STARTING", "STOPPING", "RUNNING"] } },
      data:  { status: "STOPPED" },
    });
    if (stale.count > 0) {
      console.log(`⚠️  Reset ${stale.count} stale agent(s) → STOPPED`);
    }
  } catch (err) {
    // Non-fatal — log and continue
    console.warn("⚠️  Could not reset stale agents:", err);
  }

  // Start HTTP server
  startServer(PORT);

  console.log("✅ Worker ready");
}

// ── Shutdown ──────────────────────────────────────────────────────────────────

async function shutdown(signal: string) {
  console.log(`\n🛑 ${signal} received — shutting down…`);

  const running = listRunningAgents();
  if (running.length > 0) {
    console.log(`   Stopping ${running.length} running agent(s)…`);
    // engine.stopAgent is synchronous (sends SIGTERM); give processes 5s to exit
    const { stopAgent } = await import("./engine.js");
    for (const id of running) {
      try { stopAgent(id); } catch { /* best effort */ }
    }
    await new Promise((r) => setTimeout(r, 5000));
  }

  await prisma.$disconnect();
  console.log("👋 Worker stopped.");
  process.exit(0);
}

process.on("SIGINT",  () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

// Catch unhandled promise rejections so the worker doesn't silently die
process.on("unhandledRejection", (reason) => {
  console.error("⚠️  Unhandled rejection:", reason);
});

process.on("uncaughtException", (err) => {
  console.error("💥 Uncaught exception:", err);
  process.exit(1);
});

main().catch((err) => {
  console.error("Fatal worker error:", err);
  process.exit(1);
});