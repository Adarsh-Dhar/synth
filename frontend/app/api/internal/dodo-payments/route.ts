import { NextRequest, NextResponse } from "next/server";
import { createHmac, timingSafeEqual } from "crypto";
import { prisma } from "@/lib/prisma";

function pickStatus(raw: unknown): string {
  const value = String(raw || "").trim().toLowerCase();
  if (value === "active" || value === "paid" || value === "settled") return "ACTIVE";
  if (value === "expired" || value === "cancelled" || value === "canceled") return "INACTIVE";
  return "PENDING";
}

function safeEqHex(expectedHex: string, providedHex: string): boolean {
  const a = Buffer.from(expectedHex, "hex");
  const b = Buffer.from(providedHex, "hex");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function validDateOrNull(value: unknown): Date | null {
  if (!value) return null;
  const d = new Date(String(value));
  return Number.isNaN(d.getTime()) ? null : d;
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

export async function POST(req: NextRequest) {
  const expectedSecret = String(process.env.DODO_WEBHOOK_SECRET || "").trim();
  const authHeader = String(req.headers.get("authorization") || "").trim();
  const signatureHeader = String(req.headers.get("x-dodo-signature") || "").trim().toLowerCase();

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

  const computedSig = createHmac("sha256", expectedSecret).update(rawBody).digest("hex");
  if (!safeEqHex(computedSig, signatureHeader)) {
    return NextResponse.json({ error: "invalid_signature" }, { status: 401 });
  }

  let body: Record<string, unknown>;
  try {
    body = JSON.parse(rawBody) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }

  const eventName = String(body.event || body.type || "").trim().toLowerCase();
  if (eventName !== "payment.succeeded") {
    return NextResponse.json({ ok: true, ignored: true, event: eventName || "unknown" }, { status: 200 });
  }

  const metadataCandidate = (body.metadata ?? body.data) as Record<string, unknown> | undefined;

  const agentId = String(body.agentId || metadataCandidate?.agentId || "").trim();
  const customerId = String(body.customerId || metadataCandidate?.customerId || "").trim();
  const externalReference = String(
    body.externalReference || body.orderId || body.paymentId || metadataCandidate?.externalReference || "",
  ).trim();

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

  const subscription = await prisma.subscription.upsert({
    where: { externalReference },
    update: {
      status: "ACTIVE",
      plan: body.plan ? String(body.plan) : undefined,
      webhookUrl: body.webhookUrl ? String(body.webhookUrl) : undefined,
      validUntil: validDateOrNull(body.validUntil) ?? undefined,
      metadata: metadata as any,
    },
    create: {
      agentId,
      provider: "dodo",
      status: "ACTIVE",
      externalReference,
      plan: body.plan ? String(body.plan) : null,
      webhookUrl: body.webhookUrl ? String(body.webhookUrl) : null,
      validUntil: validDateOrNull(body.validUntil),
      metadata: metadata as any,
    },
  });

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
