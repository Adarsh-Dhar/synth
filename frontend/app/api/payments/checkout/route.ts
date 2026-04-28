import { NextRequest, NextResponse } from "next/server";
import { requireWalletAuth } from "@/lib/auth/server";
import axios from "axios";

type CheckoutBody = {
  planId?: string;
  successUrl?: string;
  cancelUrl?: string;
  metadata?: Record<string, unknown>;
};

export async function POST(req: NextRequest) {
  const auth = await requireWalletAuth(req);
  if (auth.error || !auth.user) {
    return auth.error ?? NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  }

  const body = (await req.json().catch(() => ({}))) as CheckoutBody;
  const planId = String(body.planId || process.env.DODO_PLAN_PRO_ID || "").trim();

  if (!planId) {
    return NextResponse.json({ error: "Missing planId." }, { status: 400 });
  }

  const dodoApiKey = String(process.env.DODO_API_KEY || "").trim();
  const checkoutBase = String(process.env.DODO_CHECKOUT_API_URL || "https://api.dodopayments.com/v1").trim().replace(/\/+$/, "");
  if (!dodoApiKey) {
    return NextResponse.json({ error: "DODO_API_KEY not configured." }, { status: 500 });
  }

  const checkoutUrl = `${checkoutBase}/checkout`;
  const origin = req.headers.get("origin") || "http://localhost:3000";
  const successUrl = String(body.successUrl || `${origin}/dashboard/billing?status=success`).trim();
  const cancelUrl = String(body.cancelUrl || `${origin}/dashboard/billing?status=cancelled`).trim();

  try {
    const upstream = await axios.post(
      checkoutUrl,
      {
        planId,
        customerId: auth.user.id,
        successUrl,
        cancelUrl,
        metadata: {
          source: "agentia-frontend",
          walletAddress: auth.user.walletAddress,
          ...(body.metadata ?? {}),
        },
      },
      {
        headers: {
          Authorization: `Bearer ${dodoApiKey}`,
          "Content-Type": "application/json",
        },
        timeout: 15_000,
      },
    );

    const data = upstream.data as Record<string, unknown>;
    return NextResponse.json(
      {
        checkoutUrl: String(data.checkoutUrl || data.url || ""),
        overlayToken: String(data.overlayToken || data.sessionId || ""),
        provider: "dodo",
        mode: "live",
        raw: data,
      },
      { status: 200 },
    );
  } catch (error: unknown) {
    const detail = axios.isAxiosError(error)
      ? error.response?.data ?? error.message
      : error instanceof Error
        ? error.message
        : String(error);
    return NextResponse.json({ error: "checkout_failed", detail }, { status: 502 });
  }
}
