import { NextRequest, NextResponse } from "next/server";
import { requireWalletAuth } from "@/lib/auth/server";
import { prisma } from "@/lib/prisma";
import axios from "axios";

/**
 * POST /api/payments/customer-portal
 *
 * Creates a Dodo customer portal session and returns the URL.
 * The portal lets users manage/cancel subscriptions without leaving your app.
 */
export async function POST(req: NextRequest) {
  const auth = await requireWalletAuth(req);
  if (auth.error || !auth.user) {
    return auth.error ?? NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  }

  const dodoApiKey = process.env.DODO_API_KEY?.trim() ?? "";
  const checkoutBase = (process.env.DODO_CHECKOUT_API_URL ?? "https://api.dodopayments.com/v1").replace(/\/+$/, "");

  // If Dodo API key is not configured, return the internal billing page
  if (!dodoApiKey) {
    return NextResponse.json({ portalUrl: "/dashboard/billing", mode: "internal" }, { status: 200 });
  }

  const origin = req.headers.get("origin") ?? "http://localhost:3000";
  const returnUrl = `${origin}/dashboard/billing`;

  try {
    // Find the customer's Dodo customer ID from their most recent active subscription
    const agentIds = (
      await prisma.agent.findMany({
        where: { userId: auth.user.id },
        select: { id: true },
      })
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
      // No Dodo customer record yet — send to internal billing page
      return NextResponse.json({ portalUrl: "/dashboard/billing", mode: "internal" }, { status: 200 });
    }

    const response = await axios.post<{ url?: string; portalUrl?: string }>(
      `${checkoutBase}/customers/${customerId}/portal`,
      { return_url: returnUrl },
      {
        headers: {
          Authorization: `Bearer ${dodoApiKey}`,
          "Content-Type": "application/json",
        },
        timeout: 10_000,
      }
    );

    const portalUrl = String(response.data?.url ?? response.data?.portalUrl ?? "").trim();
    if (!portalUrl) {
      return NextResponse.json({ portalUrl: "/dashboard/billing", mode: "internal" }, { status: 200 });
    }

    return NextResponse.json({ portalUrl, mode: "dodo" }, { status: 200 });
  } catch (error) {
    const detail = axios.isAxiosError(error)
      ? (error.response?.data ?? error.message)
      : error instanceof Error
      ? error.message
      : String(error);

    console.warn("[/api/payments/customer-portal] Falling back to internal portal:", detail);
    return NextResponse.json({ portalUrl: "/dashboard/billing", mode: "internal" }, { status: 200 });
  }
}