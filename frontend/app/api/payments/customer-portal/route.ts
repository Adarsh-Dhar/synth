import { NextRequest, NextResponse } from "next/server";
import DodoPayments from "dodopayments";
import { requireWalletAuth } from "@/lib/auth/server";
import { prisma } from "@/lib/prisma";

const dodo = new DodoPayments({
  bearerToken: process.env.DODO_API_KEY ?? "",
  environment: process.env.DODO_PAYMENTS_ENVIRONMENT === "live_mode" ? "live_mode" : "test_mode",
});

export async function POST(req: NextRequest) {
  const auth = await requireWalletAuth(req);
  if (auth.error || !auth.user) {
    return auth.error ?? NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  }

  if (!process.env.DODO_API_KEY) {
    return NextResponse.json({ portalUrl: "/dashboard/billing", mode: "internal" }, { status: 200 });
  }

  try {
    const agentIds = (
      await prisma.agent.findMany({ where: { userId: auth.user.id }, select: { id: true } })
    ).map((a) => a.id);

    let customerId: string | null = null;
    if (agentIds.length > 0) {
      const sub = await prisma.subscription.findFirst({
        where: { agentId: { in: agentIds }, provider: "dodo" },
        orderBy: { updatedAt: "desc" },
        select: { metadata: true },
      });
      if (sub?.metadata && typeof sub.metadata === "object") {
        const meta = sub.metadata as Record<string, unknown>;
        customerId = String(meta.customerId ?? meta.customer_id ?? "").trim() || null;
      }
    }

    if (!customerId) {
      return NextResponse.json({ portalUrl: "/dashboard/billing", mode: "internal" }, { status: 200 });
    }

    const origin = req.headers.get("origin") ?? "http://localhost:3000";
    const portal = await dodo.customers.portal.create(customerId, {
      return_url: `${origin}/dashboard/billing`,
    });

    const portalUrl = (portal as unknown as Record<string, string>).link ?? "";
    if (!portalUrl) {
      return NextResponse.json({ portalUrl: "/dashboard/billing", mode: "internal" }, { status: 200 });
    }

    return NextResponse.json({ portalUrl, mode: "dodo" }, { status: 200 });
  } catch (error) {
    console.warn("[/api/payments/customer-portal] Fallback to internal:", error);
    return NextResponse.json({ portalUrl: "/dashboard/billing", mode: "internal" }, { status: 200 });
  }
}