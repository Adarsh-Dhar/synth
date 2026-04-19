// @ts-nocheck
import express from "express";
import cors from "cors";
import dotenv from "dotenv";

dotenv.config();

const app = express();
app.use(express.json());
app.use(cors());

const PORT = Number(process.env.PORT || 8011);
const HOST = process.env.HOST || "127.0.0.1";
const BASE_URL = String(process.env.GOLDRUSH_BASE_URL || "https://api.covalenthq.com/v1").replace(/\/+$/, "");

function authHeader() {
  const apiKey = String(process.env.GOLDRUSH_API_KEY || "").trim();
  if (!apiKey) throw new Error("GOLDRUSH_API_KEY is missing");
  return { Authorization: `Bearer ${apiKey}` };
}

app.get("/health", (_req, res) => {
  res.json({ ok: true, service: "goldrush-mcp-server" });
});

app.post("/mcp/goldrush/token-balances", async (req, res) => {
  try {
    const wallet = String(req.body.wallet || "").trim();
    const network = String(req.body.network || process.env.GOLDRUSH_NETWORK_ID || "solana-mainnet").trim();
    if (!wallet) return res.status(400).json({ error: "wallet is required" });

    const url = `${BASE_URL}/${network}/address/${encodeURIComponent(wallet)}/balances_v2/`;
    const upstream = await fetch(url, { headers: authHeader() });
    const body = await upstream.text();
    return res.status(upstream.status).type("application/json").send(body);
  } catch (err) {
    return res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

app.post("/mcp/goldrush/decoded-events", async (req, res) => {
  try {
    const wallet = String(req.body.wallet || "").trim();
    const network = String(req.body.network || process.env.GOLDRUSH_NETWORK_ID || "solana-mainnet").trim();
    if (!wallet) return res.status(400).json({ error: "wallet is required" });

    const url = `${BASE_URL}/${network}/address/${encodeURIComponent(wallet)}/transactions_v3/`;
    const upstream = await fetch(url, { headers: authHeader() });
    const body = await upstream.text();
    return res.status(upstream.status).type("application/json").send(body);
  } catch (err) {
    return res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

app.listen(PORT, HOST, () => {
  console.log(`[goldrush-mcp] listening on http://${HOST}:${PORT}`);
});
