import express from "express";
import dotenv from "dotenv";
import { createHmac, timingSafeEqual } from "node:crypto";

dotenv.config();

const app = express();
app.use("/dodo/webhook", express.raw({ type: "*/*", limit: "1mb" }));
app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: true }));

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
  const q = String(query || "").toLowerCase();
  const includesWebhook = /webhook|signature|hmac/.test(q);
  const includesCheckout = /checkout|plan|billing|payment/.test(q);
  const includesMetering = /meter|usage|threshold/.test(q);

  const sections: string[] = [];
  sections.push("Dodo MCP docs: use signed HTTP APIs and webhook verification over the raw request body.");
  if (includesCheckout) {
    sections.push("Checkout: create a subscription session with planId, customerId, successUrl, cancelUrl, and metadata using the Dodo payments API.");
  }
  if (includesWebhook) {
    sections.push("Webhook: verify x-dodo-signature using HMAC-SHA256 over raw body or timestamp.rawBody.");
  }
  if (includesMetering) {
    sections.push("Metering: emit usage events to configured billing endpoint with plan/customer metadata.");
  }
  if (!includesCheckout && !includesWebhook && !includesMetering) {
    sections.push("Skills: checkout creation, webhook verification, and usage metering events.");
  }
  sections.push("Reference: docs.dodopayments.com for public product guidance and API concepts.");
  return sections.join(" ");
}

app.get("/", (req, res) => {
  res.json({ status: "dodo-mcp-server", version: "0.1.0" });
});

app.get("/mcp/dodo/skills", (req, res) => {
  res.json({
    result: {
      isError: false,
      content: [
        { type: "text", text: "Dodo MCP skills: dodo_checkout, dodo_metering, dodo_webhook verification" }
      ]
    }
  });
});

app.post(["/mcp/dodo/docs", "/dodo/docs/search", "/search"], async (req, res) => {
  const q = (req.body && req.body.query) || req.query.q || "";
  const text = buildDocsAnswer(String(q));
  return res.json({
    result: {
      isError: false,
      content: [{ type: "text", text }]
    }
  });
});

app.post("/dodo/webhook", (req, res) => {
  if (!DODO_WEBHOOK_SECRET) {
    return res.status(500).json({ error: "DODO_WEBHOOK_SECRET not configured" });
  }

  const signature = normalizeSignature(String(req.headers["x-dodo-signature"] || ""));
  const timestamp = String(req.headers["x-dodo-timestamp"] || "").trim();
  const rawBody = Buffer.isBuffer(req.body)
    ? req.body.toString("utf8")
    : typeof req.body === "string"
      ? req.body
      : JSON.stringify(req.body ?? {});

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

app.post("/dodo/checkout", async (req, res) => {
  const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : req.body || {};
  const planId = String(body.planId || process.env.DODO_PLAN_PRO_ID || "").trim();
  if (!planId) {
    return res.status(400).json({ error: "missing_plan_id" });
  }
  const checkoutBase = String(process.env.DODO_CHECKOUT_API_URL || "https://api.dodopayments.com/v1").trim().replace(/\/+$/, "");
  const checkoutUrl = `${checkoutBase}/subscriptions`;
  const successUrl = String(body.successUrl || process.env.DODO_CHECKOUT_SUCCESS_URL || "http://localhost:3000/dashboard/billing?status=success").trim();
  const cancelUrl = String(body.cancelUrl || process.env.DODO_CHECKOUT_CANCEL_URL || "http://localhost:3000/dashboard/billing?status=cancelled").trim();
  const apiKey = String(process.env.DODO_API_KEY || "").trim();

  if (!apiKey) {
    return res.status(500).json({ error: "DODO_API_KEY not configured" });
  }

  const customerId = String(body.customerId || process.env.DODO_CUSTOMER_ID || "").trim();
  const metadata = typeof body.metadata === "object" && body.metadata ? body.metadata : {};

  try {
    const upstream = await fetch(checkoutUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        planId,
        customerId,
        successUrl,
        cancelUrl,
        metadata,
      }),
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
    console.error("Dodo checkout proxy failed:", err instanceof Error ? err.message : String(err));
    return res.status(502).json({ error: "checkout_failed" });
  }
});

app.post("/dodo/meter", (req, res) => {
  const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : req.body || {};
  return res.json({ ok: true, accepted: true, event: body });
});

app.listen(PORT, () => {
  console.log(`Dodo MCP server listening on http://127.0.0.1:${PORT}`);
});
