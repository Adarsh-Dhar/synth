// @ts-nocheck
import express from "express";
import cors from "cors";
import dotenv from "dotenv";

dotenv.config();

const app = express();
app.use(express.json());
app.use(cors());

const PORT = Number(process.env.PORT || 8012);
const HOST = process.env.HOST || "127.0.0.1";
const BASE_URL = String(process.env.MAGICBLOCK_PRIVATE_PAYMENTS_BASE_URL || "").trim().replace(/\/+$/, "");

async function forward(path: string, body: Record<string, unknown>) {
  if (!BASE_URL) throw new Error("MAGICBLOCK_PRIVATE_PAYMENTS_BASE_URL is missing");
  const res = await fetch(`${BASE_URL}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, text };
}

app.get("/health", (_req, res) => {
  res.json({ ok: true, service: "magicblock-mcp-server" });
});

for (const endpoint of ["deposit", "transfer", "withdraw"]) {
  app.post(`/mcp/magicblock/${endpoint}`, async (req, res) => {
    try {
      const out = await forward(`/${endpoint}`, req.body || {});
      return res.status(out.status).type("application/json").send(out.text);
    } catch (err) {
      return res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });
}

app.listen(PORT, HOST, () => {
  console.log(`[magicblock-mcp] listening on http://${HOST}:${PORT}`);
});
