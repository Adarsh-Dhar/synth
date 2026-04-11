import express from "express";
import {
  startAgent,
  stopAgent,
  getAgentStatus,
  getAgentLogs,
  listRunningAgents,
} from "./engine.js";

const app = express();
app.use(express.json());

const SECRET = process.env.WORKER_SECRET ?? "dev-worker-secret";

function requireAuth(
  req:  express.Request,
  res:  express.Response,
  next: express.NextFunction,
) {
  const auth = req.headers.authorization;
  if (!auth || auth !== `Bearer ${SECRET}`) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  next();
}

// ── Health (no auth) ──────────────────────────────────────────────────────────
app.get("/health", (_req, res) => {
  res.json({ status: "ok", running: listRunningAgents() });
});

// ── Start ─────────────────────────────────────────────────────────────────────
app.post("/agents/:id/start", requireAuth, async (req, res) => {
  const { id } = req.params;
  // Expect files and configuration in the request body
  const { files, configuration } = req.body;
  if (!Array.isArray(files) || files.length === 0) {
    return res.status(400).json({ success: false, error: "Missing or empty files array in request body" });
  }
  try {
    res.json(await startAgent({
      agentId: id.toString(),
      files,
      configuration: configuration ?? {},
    }));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[server] startAgent(${id}):`, message);
    res.status(500).json({ success: false, error: message });
  }
});

// ── Stop ──────────────────────────────────────────────────────────────────────
app.post("/agents/:id/stop", requireAuth, async (req, res) => {
  const { id } = req.params;
  try {
    res.json(await stopAgent(id.toString()));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[server] stopAgent(${id}):`, message);
    res.status(500).json({ success: false, error: message });
  }
});

// ── Status ────────────────────────────────────────────────────────────────────
app.get("/agents/:id/status", requireAuth, (req, res) => {
  res.json(getAgentStatus(req.params.id.toString()));
});

// ── Logs ──────────────────────────────────────────────────────────────────────
// GET /agents/:id/logs?since=<epoch_ms>
// Returns up to 500 log lines. If `since` is provided, returns only newer entries.
app.get("/agents/:id/logs", requireAuth, (req, res) => {
  const { id }   = req.params;
  const sinceRaw = req.query.since as string | undefined;
  const since    = sinceRaw ? parseInt(sinceRaw, 10) : undefined;

  const entries = getAgentLogs(id.toString(), since);
  res.json({ agentId: id, entries });
});

export function startServer(port: number) {
  app.listen(port, () => {
    console.log(`🌐 Worker HTTP server listening on port ${port}`);
  });
}