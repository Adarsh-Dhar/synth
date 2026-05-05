import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireWalletAuth } from "@/lib/auth/server";

export async function POST(req: NextRequest) {
  const auth = await requireWalletAuth(req);
  if (auth.error || !auth.user) {
    return auth.error ?? NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  }

  const body = (await req.json().catch(() => ({}))) as {
    action?: "create" | "upgrade" | "cancel";
    plan?: string;
    agentId?: string;
  };

  const action = body.action || "create";
  const plan = String(body.plan || "FREE").toUpperCase();
  const planLower = action === "cancel" ? "free" : plan.toLowerCase();
  const tierValue = action === "cancel" ? "FREE" : plan;

  // ── FIX: Update BOTH subscriptionTier AND plan ──
  await prisma.user.update({
    where: { id: auth.user.id },
    data: {
      subscriptionTier: tierValue,
      plan: planLower,
      ...(tierValue !== "FREE" ? { planStartedAt: new Date() } : {}),
    },
  });

  return NextResponse.json({ ok: true, action, tier: tierValue }, { status: 200 });
}