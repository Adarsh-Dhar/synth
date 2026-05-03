import { NextRequest, NextResponse } from "next/server";
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
      planExpiresAt: true,
      monthlyUsageUnits: true,
    },
  });

  if (!user) {
    return NextResponse.json({ error: "User not found." }, { status: 404 });
  }

  const tier = String(user.plan || "free").toUpperCase();
  const planExpired = Boolean(user.planExpiresAt && user.planExpiresAt.getTime() <= Date.now());
  const effectiveTier = planExpired ? "FREE" : tier;
  const limits = LIMITS_BY_TIER[effectiveTier] ?? LIMITS_BY_TIER.FREE;
  const unlimited = effectiveTier === "ENTERPRISE";

  const [agentCount, runningCount, subscription] = await Promise.all([
    prisma.agent.count({ where: { userId: auth.user.id } }),
    prisma.agent.count({ where: { userId: auth.user.id, status: "RUNNING" } }),
    prisma.subscription.findFirst({
      where: {
        agent: { userId: auth.user.id },
        provider: "dodo",
      },
      orderBy: { updatedAt: "desc" },
      select: {
        id: true,
        status: true,
        plan: true,
        validUntil: true,
        externalReference: true,
        createdAt: true,
        updatedAt: true,
      },
    }),
  ]);

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
