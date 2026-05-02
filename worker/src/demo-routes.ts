/**
 * worker/src/demo-routes.ts
 *
 * Express routes that the demo runner calls:
 *   POST /demo/run    — receive generated files, write to disk, start agent
 *   GET  /demo/logs/:id — SSE stream of agent stdout
 *   POST /demo/stop/:id — kill the agent
 */

import { Router, Request, Response } from "express";
import fs from "fs";
import path from "path";
import { spawn, ChildProcess } from "child_process";
import { randomUUID } from "crypto";

const router = Router();

// Map of agentId → child process
const runningAgents = new Map<string, ChildProcess>();
// Map of agentId → log buffer (last 500 lines)
const logBuffers = new Map<string, string[]>();
// Map of agentId → SSE response streams
const sseClients = new Map<string, Set<Response>>();

const GENERATED_BASE = path.resolve(
  __dirname,
  "../../agents/generated"
);

function ensureDir(p: string) {
  fs.mkdirSync(p, { recursive: true });
}

function appendLog(agentId: string, line: string) {
  if (!logBuffers.has(agentId)) logBuffers.set(agentId, []);
  const buf = logBuffers.get(agentId)!;
  buf.push(line);
  if (buf.length > 500) buf.shift();

  const clients = sseClients.get(agentId);
  if (clients) {
    for (const res of clients) {
      try {
        res.write(`data: ${JSON.stringify({ line, ts: Date.now() })}\n\n`);
      } catch (_) {}
    }
  }
}

// POST /demo/run
router.post("/run", async (req: Request, res: Response) => {
  try {
    const { botName, files, env: envOverrides } = req.body as {
      botName: string;
      files: Array<{ filepath: string; content: string }>;
      env: Record<string, string>;
    };

    if (!files?.length) {
      return res.status(400).json({ error: "No files provided" });
    }

    const agentId = randomUUID();
    const botDir = path.join(GENERATED_BASE, agentId);
    ensureDir(botDir);

    // Write all files
    for (const f of files) {
      const fullPath = path.join(botDir, f.filepath);
      ensureDir(path.dirname(fullPath));
      fs.writeFileSync(fullPath, f.content, "utf-8");
    }

    // Build .env for the process
    const botEnv: NodeJS.ProcessEnv = {
      ...process.env,
      ...envOverrides,
      MCP_GATEWAY_URL: envOverrides.MCP_GATEWAY_URL ?? "http://127.0.0.1:8001",
      SIMULATION_MODE: envOverrides.SIMULATION_MODE ?? "true",
    };

    // Install deps then run
    const install = spawn("npm", ["install", "--no-audit", "--no-fund"], {
      cwd: botDir,
      env: botEnv,
      stdio: ["ignore", "pipe", "pipe"],
    });

    install.stdout?.on("data", (d: Buffer) =>
      appendLog(agentId, `[install] ${d.toString().trim()}`)
    );
    install.stderr?.on("data", (d: Buffer) =>
      appendLog(agentId, `[install:err] ${d.toString().trim()}`)
    );

    install.on("close", (code) => {
      if (code !== 0) {
        appendLog(agentId, `[demo] npm install failed (code ${code}). Aborting.`);
        return;
      }

      const indexTs = path.join(botDir, "src", "index.ts");
      const child = spawn(
        "npx",
        ["tsx", indexTs],
        {
          cwd: botDir,
          env: botEnv,
          stdio: ["ignore", "pipe", "pipe"],
        }
      );

      runningAgents.set(agentId, child);
      appendLog(agentId, `[demo] Bot "${botName}" started (pid=${child.pid})`);

      child.stdout?.on("data", (d: Buffer) => {
        for (const line of d.toString().split("\n")) {
          if (line.trim()) appendLog(agentId, line);
        }
      });
      child.stderr?.on("data", (d: Buffer) => {
        for (const line of d.toString().split("\n")) {
          if (line.trim()) appendLog(agentId, `[stderr] ${line}`);
        }
      });
      child.on("close", (c) => {
        appendLog(agentId, `[demo] Bot exited (code ${c})`);
        runningAgents.delete(agentId);
        // Close all SSE clients
        sseClients.get(agentId)?.forEach((r) => {
          try { r.end(); } catch (_) {}
        });
        sseClients.delete(agentId);
      });
    });

    return res.json({ agentId, botDir, status: "starting" });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return res.status(500).json({ error: msg });
  }
});

// GET /demo/logs/:id  — SSE stream
router.get("/logs/:id", (req: Request, res: Response) => {
  const id = req.params.id as string;

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();

  // Send buffered history first
  const history = logBuffers.get(id) ?? [];
  for (const line of history) {
    res.write(`data: ${JSON.stringify({ line, ts: Date.now() })}\n\n`);
  }

  // Register as live client
  if (!sseClients.has(id)) sseClients.set(id, new Set());
  sseClients.get(id)!.add(res);

  req.on("close", () => {
    sseClients.get(id)?.delete(res);
  });
});

// POST /demo/stop/:id
router.post("/stop/:id", (req: Request, res: Response) => {
  const id = req.params.id as string;
  const child = runningAgents.get(id);
  if (!child) {
    return res.status(404).json({ error: "Agent not found or already stopped" });
  }
  child.kill("SIGTERM");
  runningAgents.delete(id);
  appendLog(id, "[demo] Agent stopped via /demo/stop");
  return res.json({ stopped: true, agentId: id });
});

// GET /demo/list  — for debugging
router.get("/list", (_req: Request, res: Response) => {
  const agents = [];
  for (const [id] of runningAgents) {
    agents.push({ agentId: id, running: true });
  }
  return res.json({ agents });
});

export default router;