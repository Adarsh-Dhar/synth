import { NextRequest, NextResponse } from "next/server";
import { createHmac, timingSafeEqual } from "crypto";
import { prisma } from "@/lib/prisma";

const WEBHOOK_TOLERANCE_SECONDS = Number(process.env.DODO_WEBHOOK_TOLERANCE_SECONDS || 300);

function pickStatus(raw: unknown): string {
  const value = String(raw || "").trim().toLowerCase();
  if (value === "active" || value === "paid" || value === "settled") return "ACTIVE";
  if (value === "expired" || value === "cancelled" || value === "canceled") return "INACTIVE";
  return "PENDING";
}

function safeEqHex(expectedHex: string, providedHex: string): boolean {
  const hexPattern = /^[0-9a-f]+$/i;
  if (!hexPattern.test(expectedHex) || !hexPattern.test(providedHex)) return false;
  if (expectedHex.length % 2 !== 0 || providedHex.length % 2 !== 0) return false;
  const a = Buffer.from(expectedHex, "hex");
  const b = Buffer.from(providedHex, "hex");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function normalizeSignature(raw: string): string {
  const value = String(raw || "").trim().toLowerCase();
  if (!value) return "";
  if (value.startsWith("sha256=")) return value.slice("sha256=".length).trim();
  return value;
}

function hasFreshTimestamp(rawTimestamp: string): boolean {
  const ts = Number(String(rawTimestamp || "").trim());
  if (!Number.isFinite(ts) || ts <= 0) return false;
  const now = Math.floor(Date.now() / 1000);
  return Math.abs(now - ts) <= WEBHOOK_TOLERANCE_SECONDS;
}

function validDateOrNull(value: unknown): Date | null {
  if (!value) return null;
  const d = new Date(String(value));
  return Number.isNaN(d.getTime()) ? null : d;
}

function getEventStatus(eventName: string, body: Record<string, unknown>): string {
  if (eventName === "payment.failed" || eventName === "subscription.cancelled" || eventName === "subscription.canceled") {
    return "INACTIVE";
  }
  const statusSource = body.status ?? body.paymentStatus ?? body.subscriptionStatus;
  return pickStatus(statusSource);
}

function tierFromPlan(plan: string | null | undefined): string {
  const normalized = String(plan || "").toUpperCase();
  if (normalized.includes("ENTERPRISE")) return "ENTERPRISE";
  if (normalized.includes("PRO")) return "PRO";
  return "FREE";
}

async function upsertSubscriptionByReference(args: {
  agentId: string;
  externalReference: string;
  customerId: string;
  metadata: Record<string, unknown>;
  body: Record<string, unknown>;
  status: string;
}) {
  const { agentId, externalReference, customerId, metadata, body, status } = args;
  const validUntil = validDateOrNull(body.validUntil);
  const plan = body.plan ? String(body.plan) : null;
  const webhookUrl = body.webhookUrl ? String(body.webhookUrl) : null;

  const existing = await prisma.subscription.findUnique({
    where: { externalReference },
  });

  const patch = {
    status,
    plan: plan ?? undefined,
    webhookUrl: webhookUrl ?? undefined,
    validUntil: validUntil ?? undefined,
    metadata: metadata as any,
  };

  if (existing) {
    return prisma.subscription.update({
      where: { externalReference },
      data: patch,
    });
  }

  try {
    return await prisma.subscription.create({
      data: {
        agentId,
        provider: "dodo",
        status,
        externalReference,
        plan,
        webhookUrl,
        validUntil,
        metadata: metadata as any,
      },
    });
  } catch (error: unknown) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      (error as { code: string }).code === "P2002"
    ) {
      return prisma.subscription.update({
        where: { externalReference },
        data: patch,
      });
    }
    throw error;
  }
}

async function findSubscriptionByEvent(body: Record<string, unknown>, metadataCandidate?: Record<string, unknown>) {
  const externalReference = String(
    body.externalReference || body.orderId || body.paymentId || metadataCandidate?.externalReference || "",
  ).trim();
  if (!externalReference) return null;

  return prisma.subscription.findUnique({
    where: { externalReference },
  });
}

async function maybeDeliverX402(agentId: string, externalReference: string, metadata: unknown) {
  const endpoint = String(process.env.X402_DELIVERY_ENDPOINT || "").trim();
  if (!endpoint) return;

  await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(process.env.X402_DELIVERY_SECRET
        ? { Authorization: `Bearer ${process.env.X402_DELIVERY_SECRET}` }
        : {}),
    },
    body: JSON.stringify({
      agentId,
      externalReference,
      metadata,
      source: "dodo",
    }),
  }).catch(() => {
    // Best effort delivery path; webhook acknowledgement should not fail on network issues.
  });
}

async function syncUserTierFromAgent(agentId: string, tier: string) {
  const agent = await prisma.agent.findUnique({ where: { id: agentId }, select: { userId: true } });
  if (!agent?.userId) return;
  await prisma.user.update({
    where: { id: agent.userId },
    data: { subscriptionTier: tier },
  });
}

export async function POST(req: NextRequest) {
  const expectedSecret = String(process.env.DODO_WEBHOOK_SECRET || "").trim();
  const authHeader = String(req.headers.get("authorization") || "").trim();
  const signatureHeader = normalizeSignature(String(req.headers.get("x-dodo-signature") || ""));
  const timestampHeader = String(req.headers.get("x-dodo-timestamp") || "").trim();

  if (!expectedSecret) {
    return NextResponse.json({ error: "server_not_configured" }, { status: 500 });
  }

  const rawBody = await req.text();
  if (!authHeader || authHeader !== `Bearer ${expectedSecret}`) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  if (!signatureHeader) {
    return NextResponse.json({ error: "missing_signature" }, { status: 401 });
  }

  if (timestampHeader && !hasFreshTimestamp(timestampHeader)) {
    return NextResponse.json({ error: "stale_timestamp" }, { status: 401 });
  }

  // Prefer timestamped signature payload when provided; fallback to raw body compatibility.
  const timestampedPayload = timestampHeader ? `${timestampHeader}.${rawBody}` : "";
  const computedSigTimestamped = timestampedPayload
    ? createHmac("sha256", expectedSecret).update(timestampedPayload).digest("hex")
    : "";
  const computedSigRaw = createHmac("sha256", expectedSecret).update(rawBody).digest("hex");
  const validSig = safeEqHex(computedSigTimestamped, signatureHeader) || safeEqHex(computedSigRaw, signatureHeader);

  if (!validSig) {
    return NextResponse.json({ error: "invalid_signature" }, { status: 401 });
  }

  let body: Record<string, unknown>;
  try {
    body = JSON.parse(rawBody) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }

  const eventName = String(body.event || body.type || "").trim().toLowerCase();

  const metadataCandidate = (body.metadata ?? body.data) as Record<string, unknown> | undefined;

  const agentId = String(body.agentId || metadataCandidate?.agentId || "").trim();
  const customerId = String(body.customerId || metadataCandidate?.customerId || "").trim();
  const externalReference = String(
    body.externalReference || body.orderId || body.paymentId || metadataCandidate?.externalReference || "",
  ).trim();

  if (!eventName) {
    return NextResponse.json({ error: "missing_event" }, { status: 400 });
  }

  if (eventName === "payment.succeeded") {
    if (!agentId || !customerId || !externalReference) {
      return NextResponse.json(
        { error: "agentId, customerId, and externalReference are required" },
        { status: 400 },
      );
    }

    const agent = await prisma.agent.findUnique({
      where: { id: agentId },
      select: { id: true },
    });

    if (!agent) {
      return NextResponse.json({ error: "agent_not_found" }, { status: 404 });
    }

    const metadata = JSON.parse(JSON.stringify({
      ...body,
      metadata: {
        ...(typeof metadataCandidate === "object" && metadataCandidate ? metadataCandidate : {}),
        customerId,
      },
    })) as Record<string, unknown>;

    const subscription = await upsertSubscriptionByReference({
      agentId,
      externalReference,
      customerId,
      metadata,
      body,
      status: getEventStatus(eventName, body),
    });

    await syncUserTierFromAgent(agentId, tierFromPlan(subscription.plan));

    await maybeDeliverX402(agentId, externalReference, metadata);

    return NextResponse.json(
      {
        ok: true,
        subscriptionId: subscription.id,
        status: subscription.status,
        provider: subscription.provider,
        customerId,
      },
      { status: 200 },
    );
  }

  if (
    eventName === "payment.failed" ||
    eventName === "subscription.cancelled" ||
    eventName === "subscription.canceled" ||
    eventName === "subscription.downgraded"
  ) {
    const subscription = await findSubscriptionByEvent(body, metadataCandidate);
    if (!subscription) {
      return NextResponse.json({ ok: true, ignored: true, event: eventName }, { status: 200 });
    }

    const metadata = JSON.parse(JSON.stringify({
      ...body,
      metadata: {
        ...(typeof metadataCandidate === "object" && metadataCandidate ? metadataCandidate : {}),
        customerId: customerId || undefined,
      },
    })) as Record<string, unknown>;

    const updated = await prisma.subscription.update({
      where: { externalReference: subscription.externalReference },
      data: {
        status: "INACTIVE",
        metadata: metadata as any,
        validUntil: validDateOrNull(body.validUntil) ?? subscription.validUntil,
      },
    });

    await syncUserTierFromAgent(updated.agentId, "FREE");

    return NextResponse.json(
      { ok: true, subscriptionId: updated.id, status: updated.status, provider: updated.provider, event: eventName },
      { status: 200 },
    );
  }

  if (eventName === "subscription.upgraded") {
    const subscription = await findSubscriptionByEvent(body, metadataCandidate);
    if (!subscription) {
      return NextResponse.json({ ok: true, ignored: true, event: eventName }, { status: 200 });
    }

    const plan = String(body.plan || subscription.plan || "PRO");
    const updated = await prisma.subscription.update({
      where: { externalReference: subscription.externalReference },
      data: {
        plan,
        status: "ACTIVE",
        metadata: body as any,
      },
    });

    await syncUserTierFromAgent(updated.agentId, tierFromPlan(plan));
    return NextResponse.json({ ok: true, event: eventName, tier: tierFromPlan(plan) }, { status: 200 });
  }

  if (eventName === "usage.threshold_reached") {
    return NextResponse.json({ ok: true, event: eventName, threshold: true }, { status: 200 });
  }

  return NextResponse.json({ ok: true, ignored: true, event: eventName || "unknown" }, { status: 200 });
}
