import express from "express";
import dotenv from "dotenv";
import { createHmac, timingSafeEqual } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { z } from "zod";

dotenv.config();

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

// Helper to get local directory in ES Modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load dynamic knowledge base
const docsPath = path.resolve(__dirname, "../docs.json");
let rawDocs: any[] = [];
try {
  rawDocs = JSON.parse(fs.readFileSync(docsPath, "utf-8"));
} catch (err) {
  console.warn("Dodo docs.json not found or invalid:", err);
  rawDocs = [];
}

const app = express();
const PORT = Number(process.env.PORT || 5002);
const DODO_WEBHOOK_SECRET = String(process.env.DODO_WEBHOOK_SECRET || "").trim();

function normalizeSignature(raw: string): string {
  const value = String(raw || "").trim().toLowerCase();
  if (!value) return "";
  if (value.startsWith("sha256=")) return value.slice("sha256=".length).trim();
  return value;
}

function safeEqHex(expectedHex: string, providedHex: string): boolean {
  const hexPattern = /^[0-9a-f]+$/i;
  if (!hexPattern.test(expectedHex) || !hexPattern.test(providedHex)) return false;
  if (expectedHex.length !== providedHex.length || expectedHex.length % 2 !== 0) return false;
  const expected = Buffer.from(expectedHex, "hex");
  const provided = Buffer.from(providedHex, "hex");
  if (expected.length !== provided.length) return false;
  return timingSafeEqual(expected, provided);
}

function buildDocsAnswer(query: string): string {
  const q = String(query || "").trim();
  if (!q) return "Please provide specific keywords to search the Dodo docs.";

  const normalizedQuery = q.toLowerCase();

  // 1. Dynamic Retrieval: Filter only relevant schemas
  const relevantDocs = rawDocs.filter((doc: any) =>
    Array.isArray(doc.keywords) && doc.keywords.some((kw: string) => normalizedQuery.includes(kw))
  );

  // 2. Fallback: If no match, return a generic pointer
  if (relevantDocs.length === 0) {
    return "No specific schema found for your query. Ensure you are using core Dodo features (checkout, meter, webhooks).";
  }

  // 3. Assemble specifically tailored context
  let responseString = `=== DODO PAYMENTS MCP SCHEMA ===\n`;
  relevantDocs.forEach((doc: any) => {
    responseString += `${doc.schema}\n\n`;
  });

  return responseString;
}

// ==========================================
// 1. TRUE MCP IMPLEMENTATION (SSE TRANSPORT)
// ==========================================
const mcp = new McpServer({
  name: "dodo-mcp-server",
  version: "0.1.0"
});

// Register the Docs tool
mcp.tool(
  "dodo_docs",
  "Search Dodo Payments documentation to retrieve webhook and checkout schemas.",
  { query: z.string().describe("The search query keywords") },
  async ({ query }) => {
    const text = buildDocsAnswer(query || "");
    return { content: [{ type: "text", text }] };
  }
);

// Register the Skills list tool
mcp.tool(
  "dodo_skills",
  "List available Dodo skills.",
  {},
  async () => {
    return { content: [{ type: "text", text: "Dodo MCP skills: dodo_checkout, dodo_metering, dodo_webhook verification" }] };
  }
);

let transport: SSEServerTransport | null = null;

// Establish the SSE connection stream
app.get("/sse", async (req, res) => {
  transport = new SSEServerTransport("/message", res);
  await mcp.connect(transport);
});

// Native MCP JSON-RPC message endpoint
app.post("/message", async (req, res) => {
  if (transport) {
    await transport.handlePostMessage(req, res);
  } else {
    res.status(400).send("No active SSE connection");
  }
});


// ==========================================
// 2. STANDARD RUNTIME/PROXY ENDPOINTS 
// ==========================================
app.post("/dodo/webhook", express.raw({ type: "*/*", limit: "1mb" }), (req, res) => {
  if (!DODO_WEBHOOK_SECRET) {
    return res.status(500).json({ error: "DODO_WEBHOOK_SECRET not configured" });
  }

  const signature = normalizeSignature(String(req.headers["x-dodo-signature"] || ""));
  const timestamp = String(req.headers["x-dodo-timestamp"] || "").trim();
  const rawBody = Buffer.isBuffer(req.body) ? req.body.toString("utf8") : "";

  if (!signature) {
    return res.status(401).json({ error: "missing_signature" });
  }

  const timestampedPayload = timestamp ? `${timestamp}.${rawBody}` : "";
  const expectedTimestamped = timestampedPayload
    ? createHmac("sha256", DODO_WEBHOOK_SECRET).update(timestampedPayload).digest("hex")
    : "";
  const expectedRaw = createHmac("sha256", DODO_WEBHOOK_SECRET).update(rawBody).digest("hex");

  const isValid = safeEqHex(expectedRaw, signature) || safeEqHex(expectedTimestamped, signature);
  if (!isValid) {
    return res.status(401).json({ error: "invalid_signature" });
  }

  return res.json({ status: "ok", verified: true });
});

app.post("/dodo/checkout", express.json({ limit: "1mb" }), async (req, res) => {
  const body = req.body || {};
  const planId = String(body.planId || process.env.DODO_PLAN_PRO_ID || "").trim();
  if (!planId) return res.status(400).json({ error: "missing_plan_id" });

  const checkoutBase = String(process.env.DODO_CHECKOUT_API_URL || "https://api.dodopayments.com/v1").trim().replace(/\/+$/, "");
  const checkoutUrl = `${checkoutBase}/subscriptions`;
  const successUrl = String(body.successUrl || process.env.DODO_CHECKOUT_SUCCESS_URL || "http://localhost:3000/dashboard/billing?status=success").trim();
  const cancelUrl = String(body.cancelUrl || process.env.DODO_CHECKOUT_CANCEL_URL || "http://localhost:3000/dashboard/billing?status=cancelled").trim();
  const apiKey = String(process.env.DODO_API_KEY || "").trim();

  if (!apiKey) return res.status(500).json({ error: "DODO_API_KEY not configured" });

  const customerId = String(body.customerId || process.env.DODO_CUSTOMER_ID || "").trim();
  const metadata = typeof body.metadata === "object" && body.metadata ? body.metadata : {};

  try {
    const upstream = await fetch(checkoutUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({ planId, customerId, successUrl, cancelUrl, metadata }),
    });

    if (!upstream.ok) {
      const detail = await upstream.text().catch(() => "");
      return res.status(502).json({ error: "checkout_failed", detail: detail.slice(0, 500) });
    }

    const upstreamData = await upstream.json().catch(() => ({}));
    const normalized = upstreamData as Record<string, unknown>;

    return res.json({
      checkoutUrl: String(normalized.checkoutUrl || normalized.url || normalized.checkout_url || ""),
      overlayToken: String(normalized.overlayToken || normalized.sessionId || `dodo_${Date.now()}`),
      provider: "dodo",
      mode: "live",
      raw: upstreamData,
    });
  } catch (err) {
    return res.status(502).json({ error: "checkout_failed" });
  }
});

app.post("/dodo/meter", express.json({ limit: "1mb" }), (req, res) => {
  return res.json({ ok: true, accepted: true, event: req.body });
});

app.listen(PORT, () => {
  console.log(`Dodo MCP server listening on http://127.0.0.1:${PORT}`);
  console.log(`SSE endpoint established at http://127.0.0.1:${PORT}/sse`);
});