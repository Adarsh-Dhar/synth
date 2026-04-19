import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireWalletAuth } from "@/lib/auth/server";

export async function POST(req: NextRequest) {
  const auth = await requireWalletAuth(req);
  if (auth.error || !auth.user) {
    return auth.error ?? NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  }

  const body = (await req.json().catch(() => ({}))) as { usageUnits?: number };
  const delta = Math.max(0, Math.floor(Number(body.usageUnits || 0)));

  const user = await prisma.user.update({
    where: { id: auth.user.id },
    data: {
      monthlyUsageUnits: {
        increment: delta,
      },
    },
    select: {
      id: true,
      monthlyUsageUnits: true,
      subscriptionTier: true,
    },
  });

  return NextResponse.json({ ok: true, user }, { status: 200 });
}
