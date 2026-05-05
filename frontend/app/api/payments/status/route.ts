import { NextRequest, NextResponse } from "next/server";
import DodoPayments from "dodopayments";
import { prisma } from "@/lib/prisma";
import { requireWalletAuth } from "@/lib/auth/server";

type TierLimits = {
  maxAgents: number;
  maxRunning: number;
  usageUnits: number;
  credits: number;
};

const LIMITS_BY_TIER: Record<string, TierLimits> = {
  FREE: { maxAgents: 2, maxRunning: 1, usageUnits: 500, credits: 0 },
  PRO: { maxAgents: 10, maxRunning: 5, usageUnits: 10_000, credits: 2_000 },
  ENTERPRISE: { maxAgents: 100, maxRunning: 25, usageUnits: 10_000, credits: 10_000 },
};

const dodo = new DodoPayments({
  bearerToken: process.env.DODO_API_KEY ?? "",
  environment:
    process.env.DODO_PAYMENTS_ENVIRONMENT === "live_mode" ||
    process.env.DODO_PAYMENTS_ENVIRONMENT === "production"
      ? "live_mode"
      : "test_mode",
});

type DodoCreditEntitlement = {
  balance?: string;
};

async function getDodoCreditBalance(customerId: string): Promise<number> {
  if (!process.env.DODO_API_KEY || !customerId) {
    return 0;
  }

  try {
    const response = await dodo.customers.listCreditEntitlements(customerId);
    const entitlements = Array.isArray(response.items) ? (response.items as DodoCreditEntitlement[]) : [];

    return entitlements.reduce((total, item) => {
      const balance = Number(item.balance ?? 0);
      return Number.isFinite(balance) ? total + balance : total;
    }, 0);
  } catch (error) {
    console.warn("[/api/payments/status] Failed to load Dodo credit balance:", error);
    return 0;
  }
}

export async function GET(req: NextRequest) {
  const auth = await requireWalletAuth(req);
  if (auth.error || !auth.user) {
    return auth.error ?? NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  }

  const user = await prisma.user.findUnique({
    where: { id: auth.user.id },
    select: {
      id: true,
      plan: true,
      subscriptionTier: true,
      planExpiresAt: true,
      monthlyUsageUnits: true,
    },
  });

  if (!user) {
    return NextResponse.json({ error: "User not found." }, { status: 404 });
  }

  // ── FIX: Check BOTH plan and subscriptionTier, use whichever is higher ──
  const planFromPlan = String(user.plan || "free").toUpperCase();
  const planFromTier = String(user.subscriptionTier || "FREE").toUpperCase();

  // Priority: ENTERPRISE > PRO > FREE
  const tierPriority: Record<string, number> = { FREE: 0, PRO: 1, ENTERPRISE: 2 };
  const tier =
    (tierPriority[planFromPlan] ?? 0) >= (tierPriority[planFromTier] ?? 0)
      ? planFromPlan
      : planFromTier;

  const planExpired = Boolean(user.planExpiresAt && user.planExpiresAt.getTime() <= Date.now());
  const effectiveTier = planExpired ? "FREE" : tier;
  const limits = LIMITS_BY_TIER[effectiveTier] ?? LIMITS_BY_TIER.FREE;
  const unlimited = effectiveTier === "ENTERPRISE";

  const [agentCount, runningCount, subscription] = await Promise.all([
    prisma.agent.count({ where: { userId: auth.user.id } }),
    prisma.agent.count({ where: { userId: auth.user.id, status: "RUNNING" } }),
    // ── FIX: Look up subscription by userId through agents ──
    prisma.subscription.findFirst({
      where: {
        agent: { userId: auth.user.id },
      },
      orderBy: { updatedAt: "desc" },
      select: {
        id: true,
        status: true,
        plan: true,
        validUntil: true,
        externalReference: true,
        metadata: true,
        createdAt: true,
        updatedAt: true,
      },
    }),
  ]);

  const subscriptionMetadata = subscription?.metadata && typeof subscription.metadata === "object"
    ? (subscription.metadata as Record<string, unknown>)
    : null;
  const customerId = String(
    subscriptionMetadata?.customerId ??
    subscriptionMetadata?.customer_id ??
    auth.user.id
  ).trim();
  const creditBalance = await getDodoCreditBalance(customerId);

  console.log("[status] tier resolution", {
    userId: auth.user.id,
    customerId,
    planFromPlan,
    planFromTier,
    tier,
    subscriptionStatus: subscription?.status ?? null,
    creditBalance,
  });

  const usageMax = limits.usageUnits;
  const usageUnits = Math.max(0, Number(user.monthlyUsageUnits || 0));
  const usagePct = unlimited || usageMax <= 0
    ? 0
    : Math.max(0, Math.min(100, Math.round((usageUnits / usageMax) * 100)));

  return NextResponse.json({
    tier: effectiveTier,
    limits,
    usage: {
      units: usageUnits,
      max: usageMax,
      pct: usagePct,
      unlimited,
    },
    creditBalance,
    subscription: subscription
      ? {
          ...subscription,
          validUntil: subscription.validUntil?.toISOString() ?? null,
          createdAt: subscription.createdAt.toISOString(),
          updatedAt: subscription.updatedAt.toISOString(),
        }
      : null,
    agentCount,
    runningCount,
  }, { status: 200 });
}