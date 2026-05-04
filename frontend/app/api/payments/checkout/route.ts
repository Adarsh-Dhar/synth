import { NextRequest, NextResponse } from "next/server";
import DodoPayments from "dodopayments";
import { requireWalletAuth } from "@/lib/auth/server";

const dodo = new DodoPayments({
  bearerToken: process.env.DODO_API_KEY ?? "",
  environment: process.env.DODO_PAYMENTS_ENVIRONMENT === "live_mode" ? "live_mode" : "test_mode",
});

type CheckoutBody = {
  planType?: "pro" | "enterprise" | "topup";
  productId?: string;
  planId?: string;
  successUrl?: string;
  cancelUrl?: string;
  metadata?: Record<string, unknown>;
};

function resolvePlanId(planType: string, body: CheckoutBody): string {
  if (body.planId) return body.planId;
  switch (planType) {
    case "pro":
      return process.env.DODO_PLAN_PRO_ID ?? "";
    case "enterprise":
      return process.env.DODO_PLAN_ENTERPRISE_ID ?? "";
    case "topup": {
      const envKey = body.productId ?? "";
      if (envKey.startsWith("DODO_")) return process.env[envKey] ?? "";
      return envKey;
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

  if (!process.env.DODO_API_KEY) {
    return NextResponse.json({ error: "DODO_PAYMENTS_API_KEY not configured." }, { status: 500 });
  }

  const origin = req.headers.get("origin") ?? "http://localhost:3000";
  const successUrl = String(body.successUrl ?? `${origin}/dashboard/billing?dodo=success`).trim();
  const walletSlug = auth.user.walletAddress.replace(/[^a-zA-Z0-9]/g, "_").slice(0, 12);

  const sharedCustomer = {
    email: `${walletSlug}@wallet.local`,
    name: walletSlug,
  };

  const sharedMetadata = {
    source: "synth-frontend",
    walletAddress: auth.user.walletAddress,
    userId: auth.user.id,
    planType,
    ...(body.metadata ?? {}),
  };

  try {
    // Both subscriptions and one-time payments now use checkout sessions
    const session = await dodo.checkoutSessions.create({
      product_cart: [{ product_id: resolvedId, quantity: 1 }],
      customer: sharedCustomer,
      return_url: successUrl,
      metadata: sharedMetadata,
    });

    const checkoutUrl = session.checkout_url;
    if (!checkoutUrl) {
      return NextResponse.json({ error: "Dodo did not return a checkout URL." }, { status: 502 });
    }

    return NextResponse.json(
      {
        checkoutUrl,
        provider: "dodo",
        planType,
        isSubscription: planType !== "topup",
      },
      { status: 200 }
    );
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("[/api/payments/checkout] Dodo error:", message);
    return NextResponse.json({ error: "checkout_failed", detail: message }, { status: 502 });
  }
}