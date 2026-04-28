import express from "express";
import bodyParser from "body-parser";
import dotenv from "dotenv";
import { createHmac, timingSafeEqual } from "node:crypto";
dotenv.config();
const app = express();
app.use(bodyParser.json());
app.use(bodyParser.text({ type: "*/*" }));
const PORT = Number(process.env.PORT || 5002);
const DODO_WEBHOOK_SECRET = String(process.env.DODO_WEBHOOK_SECRET || "").trim();
function normalizeSignature(raw) {
    const value = String(raw || "").trim().toLowerCase();
    if (!value)
        return "";
    if (value.startsWith("sha256="))
        return value.slice("sha256=".length).trim();
    return value;
}
function safeEqHex(expectedHex, providedHex) {
    const hexPattern = /^[0-9a-f]+$/i;
    if (!hexPattern.test(expectedHex) || !hexPattern.test(providedHex))
        return false;
    if (expectedHex.length !== providedHex.length || expectedHex.length % 2 !== 0)
        return false;
    const expected = Buffer.from(expectedHex, "hex");
    const provided = Buffer.from(providedHex, "hex");
    if (expected.length !== provided.length)
        return false;
    return timingSafeEqual(expected, provided);
}
function buildDocsAnswer(query) {
    const q = String(query || "").toLowerCase();
    const includesWebhook = /webhook|signature|hmac/.test(q);
    const includesCheckout = /checkout|plan|billing|payment/.test(q);
    const includesMetering = /meter|usage|threshold/.test(q);
    const sections = [];
    sections.push("Dodo MCP docs: use HTTP APIs and signed webhooks only.");
    if (includesCheckout) {
        sections.push("Checkout: POST /v1/checkout with planId, customerId, successUrl, cancelUrl, metadata.");
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
app.post(["/mcp/dodo/docs", "/dodo/docs/search", "/search"], (req, res) => {
    const q = (req.body && req.body.query) || req.query.q || "";
    const sample = {
        result: {
            content: [
                { text: buildDocsAnswer(String(q).slice(0, 500)) }
            ]
        }
    };
    res.json(sample);
});
app.post("/dodo/webhook", (req, res) => {
    if (!DODO_WEBHOOK_SECRET) {
        return res.status(500).json({ error: "DODO_WEBHOOK_SECRET not configured" });
    }
    const signature = normalizeSignature(String(req.headers["x-dodo-signature"] || ""));
    const timestamp = String(req.headers["x-dodo-timestamp"] || "").trim();
    const rawBody = typeof req.body === "string" ? req.body : JSON.stringify(req.body ?? {});
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
app.post("/dodo/checkout", (req, res) => {
    const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : req.body || {};
    const planId = String(body.planId || process.env.DODO_PLAN_PRO_ID || "").trim();
    if (!planId) {
        return res.status(400).json({ error: "missing_plan_id" });
    }
    return res.json({
        checkoutUrl: `https://checkout.dodo.dev/session/${encodeURIComponent(planId)}`,
        overlayToken: `dodo_${Date.now()}`,
    });
});
app.post("/dodo/meter", (req, res) => {
    const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : req.body || {};
    return res.json({ ok: true, accepted: true, event: body });
});
app.listen(PORT, () => {
    console.log(`Dodo MCP server listening on http://127.0.0.1:${PORT}`);
});
