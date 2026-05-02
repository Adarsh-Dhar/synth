import { NextRequest, NextResponse } from "next/server";
import { requireWalletAuth } from "@/lib/auth/server";
import axios from "axios";

type CheckoutBody = {
  planType?: "pro" | "enterprise" | "topup";
  productId?: string;        // for one-time top-ups
  planId?: string;           // direct plan ID override
  successUrl?: string;
  cancelUrl?: string;
  metadata?: Record<string, unknown>;
};

type DodoCheckoutResponse = {
  checkoutUrl?: string;
  url?: string;
  overlayToken?: string;
  sessionId?: string;
  paymentId?: string;
  subscriptionId?: string;
  [key: string]: unknown;
};

/** Resolve the correct Dodo product/plan ID based on the requested plan type */
function resolvePlanId(planType: string, body: CheckoutBody): string {
  if (body.planId) return body.planId;

  switch (planType) {
    case "pro":
      return process.env.DODO_PLAN_PRO_ID ?? "";
    case "enterprise":
      return process.env.DODO_PLAN_ENTERPRISE_ID ?? "";
    case "topup": {
      // body.productId carries the env key name (e.g. "DODO_TOPUP_500_ID")
      // so frontend can stay decoupled from actual Dodo IDs
      const envKey = body.productId ?? "";
      if (envKey.startsWith("DODO_")) {
        return process.env[envKey] ?? "";
      }
      return envKey; // allow passing a raw product ID directly too
    }
    default:
      return process.env.DODO_PLAN_PRO_ID ?? "";
  }
}

export async function POST(req: NextRequest) {
  const auth = await requireWalletAuth(req);
  if (auth.error || !auth.user) {
    return auth.error ?? NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  }

  const body = (await req.json().catch(() => ({}))) as CheckoutBody;
  const planType = body.planType ?? "pro";
  const resolvedId = resolvePlanId(planType, body);

  if (!resolvedId) {
    return NextResponse.json(
      { error: `No product/plan ID configured for planType="${planType}". Set the corresponding DODO_* env variable.` },
      { status: 400 }
    );
  }

  const dodoApiKey = process.env.DODO_API_KEY?.trim() ?? "";
  if (!dodoApiKey) {
    return NextResponse.json({ error: "DODO_API_KEY not configured." }, { status: 500 });
  }

  const checkoutBase = (process.env.DODO_CHECKOUT_API_URL ?? "https://api.dodopayments.com/v1").replace(/\/+$/, "");
  const origin = req.headers.get("origin") ?? "http://localhost:3000";
  const successUrl = String(body.successUrl ?? `${origin}/dashboard/billing?dodo=success`).trim();
  const cancelUrl  = String(body.cancelUrl  ?? `${origin}/dashboard/billing?dodo=cancelled`).trim();

  // Choose endpoint: subscriptions for plans, payments for one-time top-ups
  const isSubscription = planType !== "topup";
  const endpoint = isSubscription
    ? `${checkoutBase}/subscriptions`
    : `${checkoutBase}/payments`;

  const payload = isSubscription
    ? {
        billing: { city: "", country: "US", state: "", street: "", zipcode: "" },
        customer: {
          customer_id: auth.user.id,
          email: `${auth.user.walletAddress.replace(/[^a-zA-Z0-9]/g, "_")}@wallet.local`,
          name: auth.user.walletAddress.slice(0, 12),
        },
        product_id: resolvedId,
        quantity: 1,
        return_url: successUrl,
        metadata: {
          source: "synth-frontend",
          walletAddress: auth.user.walletAddress,
          userId: auth.user.id,
          planType,
          ...(body.metadata ?? {}),
        },
      }
    : {
        billing: { city: "", country: "US", state: "", street: "", zipcode: "" },
        customer: {
          customer_id: auth.user.id,
          email: `${auth.user.walletAddress.replace(/[^a-zA-Z0-9]/g, "_")}@wallet.local`,
          name: auth.user.walletAddress.slice(0, 12),
        },
        product_cart: [{ product_id: resolvedId, quantity: 1 }],
        return_url: successUrl,
        metadata: {
          source: "synth-frontend",
          walletAddress: auth.user.walletAddress,
          userId: auth.user.id,
          planType,
          ...(body.metadata ?? {}),
        },
      };

  try {
    const upstream = await axios.post<DodoCheckoutResponse>(endpoint, payload, {
      headers: {
        Authorization: `Bearer ${dodoApiKey}`,
        "Content-Type": "application/json",
      },
      timeout: 15_000,
    });

    const data = upstream.data;
    const checkoutUrl =
      String(data.checkoutUrl ?? data.url ?? data.payment_link ?? "").trim();

    if (!checkoutUrl) {
      console.error("[/api/payments/checkout] Dodo returned no checkout URL:", data);
      return NextResponse.json(
        { error: "Dodo did not return a checkout URL.", raw: data },
        { status: 502 }
      );
    }

    return NextResponse.json(
      {
        checkoutUrl,
        overlayToken: String(data.overlayToken ?? data.sessionId ?? ""),
        provider: "dodo",
        planType,
        isSubscription,
        raw: data,
      },
      { status: 200 }
    );
  } catch (error: unknown) {
    const detail = axios.isAxiosError(error)
      ? (error.response?.data ?? error.message)
      : error instanceof Error
      ? error.message
      : String(error);

    console.error("[/api/payments/checkout] Dodo API error:", detail);
    return NextResponse.json({ error: "checkout_failed", detail }, { status: 502 });
  }
}