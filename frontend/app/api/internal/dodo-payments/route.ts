/* eslint-disable @typescript-eslint/no-unused-vars */
import { NextRequest, NextResponse } from "next/server";
import { createHmac, timingSafeEqual } from "crypto";
import { prisma } from "@/lib/prisma";
import { requireEnv } from "@/lib/env";

const WEBHOOK_TOLERANCE_SECONDS = Number(process.env.DODO_WEBHOOK_TOLERANCE_SECONDS || 300);

// ── Credit amounts per product ID ─────────────────────────────────────────────
const TOPUP_CREDITS_BY_PRODUCT: Record<string, number> = {
  pdt_0Ne0aafxIPJ1U3L2TuQ1l: 500,    // $4.99 → 500 credits
  pdt_0Ne0ajLByYILVD88OEGSz: 2_000,  // $14.99 → 2,000 credits
  pdt_0Ne0ariRdRBGFskEOFvXd: 10_000, // $49.99 → 10,000 credits
};

// ── Subscription plan credits (monthly allocation) ────────────────────────────
const SUBSCRIPTION_CREDITS_BY_PLAN: Record<string, number> = {
  pro: 2_000,
  enterprise: 10_000,
  free: 0,
};

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

function resolveBotId(body: Record<string, unknown>, metadataCandidate?: Record<string, unknown>): string {
  return String(
    body.agentId ||
      body.botId ||
      metadataCandidate?.botId ||
      metadataCandidate?.agentId ||
      metadataCandidate?.bot_id ||
      "",
  ).trim();
}

/**
 * Detect if this is a one-time top-up payment by checking product_id in the payload
 */
function resolveTopupCredits(body: Record<string, unknown>, metadataCandidate?: Record<string, unknown>): number {
  // Check product_id in various locations
  const productId = String(
    body.product_id ??
    body.productId ??
    metadataCandidate?.product_id ??
    metadataCandidate?.productId ??
    // Also check inside product_cart array
    (Array.isArray((body as any).product_cart)
      ? (body as any).product_cart?.[0]?.product_id
      : undefined) ??
    ""
  ).trim();

  if (productId && TOPUP_CREDITS_BY_PRODUCT[productId]) {
    return TOPUP_CREDITS_BY_PRODUCT[productId];
  }

  // Fallback: check planType in metadata to distinguish topup vs subscription
  const planType = String(metadataCandidate?.planType ?? body.planType ?? "").toLowerCase();
  if (planType === "topup") {
    // Try to resolve by amount paid
    const amount = Number(body.total ?? body.amount ?? body.price ?? 0);
    if (amount >= 40) return 10_000;
    if (amount >= 12) return 2_000;
    if (amount >= 4) return 500;
  }

  return 0;
}

/**
 * Add credits to a user by incrementing monthlyUsageUnits (we use this as credit balance)
 * Note: monthlyUsageUnits tracks usage consumed; we add a separate credit field via a raw update
 */
async function addCreditsToUser(userId: string, credits: number): Promise<void> {
  if (credits <= 0) return;
  // We store purchased credits by decrementing usage (net effect = more headroom)
  // Actually the cleanest approach: we just add to a dedicated credit balance.
  // Since the schema uses monthlyUsageUnits for consumption, we'll add credits
  // as negative usage (reduces effective usage, giving more runway).
  // This is consistent with how getDodoCreditBalance works in payments/status.
  //
  // For now, we store it in the DB via a raw increment on a credits field.
  // If the column doesn't exist yet, we fall back gracefully.
  try {
    await (prisma as any).$executeRawUnsafe(
      `UPDATE "User" SET "creditBalance" = COALESCE("creditBalance", 0) + $1 WHERE "id" = $2`,
      credits,
      userId
    );
  } catch {
    // creditBalance column may not exist yet — try adding it first
    try {
      await (prisma as any).$executeRawUnsafe(
        `ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "creditBalance" INTEGER NOT NULL DEFAULT 0`
      );
      await (prisma as any).$executeRawUnsafe(
        `UPDATE "User" SET "creditBalance" = COALESCE("creditBalance", 0) + $1 WHERE "id" = $2`,
        credits,
        userId
      );
    } catch (err2) {
      console.error("[dodo-payments] Failed to add credits to user:", err2);
    }
  }
}

// ── FIXED: Updates BOTH subscriptionTier AND plan columns ──
async function syncUserTierFromAgent(agentId: string, tier: string) {
  const normalizedTier = tier.toUpperCase();
  const planLower = normalizedTier.toLowerCase();

  const agent = await prisma.agent.findUnique({
    where: { id: agentId },
    select: { userId: true },
  });
  if (!agent?.userId) return;

  await prisma.user.update({
    where: { id: agent.userId },
    data: {
      subscriptionTier: normalizedTier,
      plan: planLower,
      ...(normalizedTier !== "FREE" ? { planStartedAt: new Date() } : {}),
    },
  });

  // Also grant the monthly subscription credits when upgrading
  const planCredits = SUBSCRIPTION_CREDITS_BY_PLAN[planLower] ?? 0;
  if (planCredits > 0) {
    await addCreditsToUser(agent.userId, planCredits);
    console.log(`[dodo-payments] Granted ${planCredits} subscription credits to user ${agent.userId}`);
  }
}

// ── Sync by walletAddress or userId from metadata ──
async function syncUserTierByMetadata(
  metadata: Record<string, unknown>,
  tier: string
): Promise<{ synced: boolean; userId: string | null }> {
  const normalizedTier = tier.toUpperCase();
  const planLower = normalizedTier.toLowerCase();

  const walletAddress = String(metadata.walletAddress ?? "").trim();
  const userId = String(metadata.userId ?? "").trim();

  if (!walletAddress && !userId) return { synced: false, userId: null };

  const user = await prisma.user.findFirst({
    where: {
      OR: [
        ...(walletAddress ? [{ walletAddress }] : []),
        ...(userId ? [{ id: userId }] : []),
      ],
    },
    select: { id: true },
  });

  if (!user) return { synced: false, userId: null };

  await prisma.user.update({
    where: { id: user.id },
    data: {
      subscriptionTier: normalizedTier,
      plan: planLower,
      ...(normalizedTier !== "FREE" ? { planStartedAt: new Date() } : {}),
    },
  });

  // Grant subscription credits
  const planCredits = SUBSCRIPTION_CREDITS_BY_PLAN[planLower] ?? 0;
  if (planCredits > 0) {
    await addCreditsToUser(user.id, planCredits);
    console.log(`[dodo-payments] Granted ${planCredits} subscription credits to user ${user.id} (metadata sync)`);
  }

  return { synced: true, userId: user.id };
}

async function forwardWebhookToWorker(agentId: string, payload: Record<string, unknown>) {
  const workerUrl = String(process.env.WORKER_URL || "http://localhost:4001").trim().replace(/\/+$/, "");
  const workerSecret = requireEnv("WORKER_SECRET");

  await fetch(`${workerUrl}/agents/${agentId}/webhook`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${workerSecret}`,
    },
    body: JSON.stringify(payload),
  }).catch((error) => {
    console.warn("[/api/internal/dodo-payments] failed to forward webhook to worker:", error);
  });
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
  }).catch(() => {});
}

// ── Helper: find or create a placeholder agent to attach subscription to ──
async function resolveAgentIdForUser(userId: string): Promise<string | null> {
  const existing = await prisma.agent.findFirst({
    where: { userId },
    orderBy: { createdAt: "desc" },
    select: { id: true },
  });
  if (existing) return existing.id;

  const agent = await prisma.agent.create({
    data: {
      name: "Subscription Placeholder",
      userId,
      status: "STOPPED",
      walletAddress: "",
    },
  }).catch(() => null);

  return agent?.id ?? null;
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

  const eventName = String(body.event_type || body.event || body.type || "").trim().toLowerCase();
  const metadataCandidate = (body.metadata ?? body.data) as Record<string, unknown> | undefined;

  let agentId = resolveBotId(body, metadataCandidate);
  const customerId = String(body.customerId || metadataCandidate?.customerId || "").trim();
  const externalReference = String(
    body.externalReference || body.orderId || body.paymentId || metadataCandidate?.externalReference || "",
  ).trim();

  if (!eventName) {
    return NextResponse.json({ error: "missing_event" }, { status: 400 });
  }

  // ── payment.succeeded ─────────────────────────────────────────────────────
  if (eventName === "payment.succeeded") {
    if (!externalReference) {
      return NextResponse.json(
        { error: "externalReference is required" },
        { status: 400 },
      );
    }

    console.log("[dodo-payments] payment.succeeded event", {
      externalReference,
      agentId,
      customerId,
      metadata: metadataCandidate,
      bodyPlan: body.plan,
    });

    // ── Detect top-up vs subscription ────────────────────────────────────────
    const topupCredits = resolveTopupCredits(body, metadataCandidate);
    const isTopup = topupCredits > 0 || String(metadataCandidate?.planType ?? "").toLowerCase() === "topup";

    if (isTopup) {
      console.log(`[dodo-payments] Detected top-up payment: ${topupCredits} credits`);

      // Resolve user from metadata
      const walletAddress = String(metadataCandidate?.walletAddress ?? "").trim();
      const userId = String(metadataCandidate?.userId ?? "").trim();

      const user = await prisma.user.findFirst({
        where: {
          OR: [
            ...(walletAddress ? [{ walletAddress }] : []),
            ...(userId ? [{ id: userId }] : []),
          ],
        },
        select: { id: true },
      });

      if (user && topupCredits > 0) {
        await addCreditsToUser(user.id, topupCredits);
        console.log(`[dodo-payments] Added ${topupCredits} credits to user ${user.id}`);

        // Also create/update a subscription record for audit trail
        let resolvedAgentId = agentId || (await resolveAgentIdForUser(user.id)) || "";
        if (resolvedAgentId && externalReference) {
          const metadata = JSON.parse(JSON.stringify({
            ...body,
            metadata: {
              ...(typeof metadataCandidate === "object" && metadataCandidate ? metadataCandidate : {}),
              customerId,
              topupCredits,
              isTopup: true,
            },
          })) as Record<string, unknown>;

          await upsertSubscriptionByReference({
            agentId: resolvedAgentId,
            externalReference,
            customerId,
            metadata,
            body: { ...body, plan: "topup" },
            status: "ACTIVE",
          });
        }

        return NextResponse.json(
          { ok: true, topup: true, credits: topupCredits, userId: user.id },
          { status: 200 }
        );
      }

      return NextResponse.json(
        { ok: true, topup: true, warning: "user_not_found", externalReference },
        { status: 200 }
      );
    }

    // ── Subscription payment ──────────────────────────────────────────────────
    const planFromMetadata = metadataCandidate?.planType ? String(metadataCandidate.planType).toUpperCase() : null;
    const planFromBody = body.plan ? String(body.plan).toUpperCase() : null;
    const tier = tierFromPlan(planFromMetadata || planFromBody || "PRO");

    console.log("[dodo-payments] tier resolution", { planFromMetadata, planFromBody, tier });

    // Try to resolve agentId from metadata
    let resolvedUserId: string | null = null;
    if (!agentId && metadataCandidate) {
      console.log("[dodo-payments] attempting to sync user tier by metadata", metadataCandidate);
      const { synced, userId: foundUserId } = await syncUserTierByMetadata(
        metadataCandidate as Record<string, unknown>,
        tier
      );
      console.log("[dodo-payments] metadata sync result:", synced);
      if (synced && foundUserId) {
        resolvedUserId = foundUserId;
        agentId = (await resolveAgentIdForUser(foundUserId)) ?? "";
      }
    }

    if (!agentId) {
      console.error("[dodo-payments] payment.succeeded with no resolvable agentId", {
        externalReference,
        metadata: metadataCandidate,
        resolvedUserId,
      });
      return NextResponse.json({ ok: true, warning: "no_agent_resolved", externalReference }, { status: 200 });
    }

    console.log("[dodo-payments] resolved agentId", agentId);

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

    const bodyWithPlan = {
      ...body,
      plan: planFromMetadata || planFromBody || "PRO",
    };

    const subscription = await upsertSubscriptionByReference({
      agentId,
      externalReference,
      customerId,
      metadata,
      body: bodyWithPlan,
      status: getEventStatus(eventName, body),
    });

    console.log("[dodo-payments] syncing user tier from agent", { agentId, tier });
    await syncUserTierFromAgent(agentId, tier);
    console.log("[dodo-payments] user tier synced successfully");

    await maybeDeliverX402(agentId, externalReference, metadata);
    await forwardWebhookToWorker(agentId, {
      ...body,
      metadata: typeof metadataCandidate === "object" && metadataCandidate ? metadataCandidate : body.metadata,
      source: "dodo",
    });

    console.log("[dodo-payments] payment.succeeded fully processed", {
      subscriptionId: subscription.id,
      status: subscription.status,
      tier,
    });

    return NextResponse.json(
      {
        ok: true,
        subscriptionId: subscription.id,
        status: subscription.status,
        provider: subscription.provider,
        customerId,
        tier,
      },
      { status: 200 },
    );
  }

  // ── payment.failed / subscription.cancelled ──────────────────────────────
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

    // Don't remove credits for topup subscriptions — they're permanent purchases
    const isTopupRecord = String(subscription.plan ?? "").toLowerCase() === "topup";
    if (!isTopupRecord) {
      await syncUserTierFromAgent(updated.agentId, "FREE");
    }

    await forwardWebhookToWorker(updated.agentId, {
      ...body,
      metadata: typeof metadataCandidate === "object" && metadataCandidate ? metadataCandidate : body.metadata,
      source: "dodo",
    });

    return NextResponse.json(
      { ok: true, subscriptionId: updated.id, status: updated.status, provider: updated.provider, event: eventName },
      { status: 200 },
    );
  }

  // ── subscription.upgraded / plan_changed ──────────────────────────────────
  if (eventName === "subscription.upgraded" || eventName === "subscription.plan_changed") {
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
    await forwardWebhookToWorker(updated.agentId, {
      ...body,
      metadata: typeof metadataCandidate === "object" && metadataCandidate ? metadataCandidate : body.metadata,
      source: "dodo",
    });
    return NextResponse.json({ ok: true, event: eventName, tier: tierFromPlan(plan) }, { status: 200 });
  }

  if (eventName === "usage.threshold_reached") {
    return NextResponse.json({ ok: true, event: eventName, threshold: true }, { status: 200 });
  }

  return NextResponse.json({ ok: true, ignored: true, event: eventName || "unknown" }, { status: 200 });
}