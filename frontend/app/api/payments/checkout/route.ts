import { NextRequest, NextResponse } from "next/server";
import { requireWalletAuth } from "@/lib/auth/server";

export async function POST(req: NextRequest) {
  const auth = await requireWalletAuth(req);
  if (auth.error || !auth.user) {
    return auth.error ?? NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  }

  const body = (await req.json().catch(() => ({}))) as { planId?: string };
  const planId = String(body.planId || process.env.DODO_PLAN_PRO_ID || "").trim();

  if (!planId) {
    return NextResponse.json({ error: "Missing planId." }, { status: 400 });
  }

  return NextResponse.json(
    {
      checkoutUrl: `/dashboard/billing?plan=${encodeURIComponent(planId)}`,
      overlayToken: `local_checkout_${Date.now()}`,
      provider: "dodo",
      mode: "scaffold",
    },
    { status: 200 },
  );
}
