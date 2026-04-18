import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

function pickStatus(raw: unknown): string {
  const value = String(raw || "").trim().toLowerCase();
  if (value === "active" || value === "paid" || value === "settled") return "ACTIVE";
  if (value === "expired" || value === "cancelled" || value === "canceled") return "INACTIVE";
  return "PENDING";
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

  if (!expectedSecret || authHeader !== `Bearer ${expectedSecret}`) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }

  const agentId = String(body.agentId || "").trim();
  const externalReference = String(
    body.externalReference || body.orderId || body.paymentId || "",
  ).trim();

  if (!agentId || !externalReference) {
    return NextResponse.json(
      { error: "agentId and externalReference are required" },
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

  const metadata = JSON.parse(JSON.stringify(body)) as Record<string, unknown>;

  const subscription = await prisma.subscription.upsert({
    where: { externalReference },
    update: {
      status: pickStatus(body.status),
      plan: body.plan ? String(body.plan) : undefined,
      webhookUrl: body.webhookUrl ? String(body.webhookUrl) : undefined,
      validUntil: body.validUntil ? new Date(String(body.validUntil)) : undefined,
      metadata: metadata as any,
    },
    create: {
      agentId,
      provider: "dodo",
      status: pickStatus(body.status),
      externalReference,
      plan: body.plan ? String(body.plan) : null,
      webhookUrl: body.webhookUrl ? String(body.webhookUrl) : null,
      validUntil: body.validUntil ? new Date(String(body.validUntil)) : null,
      metadata: metadata as any,
    },
  });

  if (subscription.status === "ACTIVE") {
    await maybeDeliverX402(agentId, externalReference, body);
  }

  return NextResponse.json(
    {
      ok: true,
      subscriptionId: subscription.id,
      status: subscription.status,
      provider: subscription.provider,
    },
    { status: 200 },
  );
}
