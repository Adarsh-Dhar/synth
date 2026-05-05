import { NextRequest, NextResponse } from "next/server";
import DodoPayments from "dodopayments";
import { requireWalletAuth } from "@/lib/auth/server";

const dodo = new DodoPayments({
  bearerToken: process.env.DODO_PAYMENTS_API_KEY ?? process.env.DODO_API_KEY ?? "",
  environment: (process.env.DODO_PAYMENTS_ENVIRONMENT === "live_mode" || process.env.DODO_PAYMENTS_ENVIRONMENT === "production") ? "live_mode" : "test_mode",
});

type CheckoutBody = {
  planType?: "pro" | "enterprise" | "topup";
  productId?: string;
  planId?: string;
  successUrl?: string;
  cancelUrl?: string;
  metadata?: Record<string, unknown>;
};

// ── Canonical product ID map ──────────────────────────────────────────────────
// Keep in sync with pricing-plans.tsx and dodo dashboard
const PRODUCT_IDS: Record<string, string> = {
  // Subscriptions
  free:       "pdt_0Ne0ZzHuknqvRLcRxK1K9",
  pro:        "pdt_0NeAqJjnHMw3zHi9kYIXS", // ✅ Correct Pro plan
  enterprise: "pdt_0Ne0aCoFw2FGrzxaPrPiN",
  // Top-ups (one-time)
  topup_500:    "pdt_0Ne0aafxIPJ1U3L2TuQ1l",
  topup_2000:   "pdt_0Ne0ajLByYILVD88OEGSz",
  topup_10000:  "pdt_0Ne0ariRdRBGFskEOFvXd",
};

function resolvePlanId(planType: string, body: CheckoutBody): string {
  if (body.planId) return body.planId;
  switch (planType) {
    case "pro":
      return body.productId ?? PRODUCT_IDS.pro ?? process.env.DODO_PLAN_PRO_ID ?? "";
    case "enterprise":
      return body.productId ?? PRODUCT_IDS.enterprise ?? process.env.DODO_PLAN_ENTERPRISE_ID ?? "";
    case "topup": {
      // Accept a direct productId from the request (set by CreditTopups component)
      const envKey = body.productId ?? "";
      if (envKey.startsWith("DODO_")) return process.env[envKey] ?? "";
      if (envKey.startsWith("pdt_")) return envKey;
      return envKey;
    }
    default:
      return body.productId ?? PRODUCT_IDS.pro ?? process.env.DODO_PLAN_PRO_ID ?? "";
  }
}

export async function POST(req: NextRequest) {
  const auth = await requireWalletAuth(req);
  console.log("[checkout] auth result:", auth);
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

  if (!process.env.DODO_PAYMENTS_API_KEY && !process.env.DODO_API_KEY) {
    return NextResponse.json({ error: "DODO_PAYMENTS_API_KEY not configured." }, { status: 500 });
  }

  const origin = req.headers.get("origin") ?? "http://localhost:3000";
  const successUrl = String(body.successUrl ?? `${origin}/dashboard/billing?dodo=success`).trim();
  const cancelUrl = String(body.cancelUrl ?? `${origin}/dashboard/billing?dodo=cancelled`).trim();
  const walletSlug = auth.user.walletAddress.replace(/[^a-zA-Z0-9]/g, "_").slice(0, 12);

  const sharedCustomer = {
    email: `${walletSlug}@wallet.local`,
    name: walletSlug,
  };

  // ── Embed all resolution metadata so the webhook can identify topup vs subscription ──
  const sharedMetadataRaw = {
    source: "synth-frontend",
    walletAddress: auth.user.walletAddress,
    userId: auth.user.id,
    planType,           // "pro" | "enterprise" | "topup" — critical for webhook handler
    product_id: resolvedId,  // Also embed product_id so webhook can look up credit amounts
    timestamp: new Date().toISOString(),
    ...(body.metadata ?? {}),
  };
  const sharedMetadata = Object.fromEntries(
    Object.entries(sharedMetadataRaw).map(([key, value]) => [key, String(value)])
  );

  console.log("[checkout] creating session with metadata:", {
    walletAddress: auth.user.walletAddress,
    userId: auth.user.id,
    planType,
    resolvedId,
  });

  try {
    const resolvedKey = process.env.DODO_PAYMENTS_API_KEY ?? process.env.DODO_API_KEY ?? "";
    const trimmedKey = resolvedKey.trim();
    console.log("[checkout] dodo key available:", Boolean(resolvedKey), "using:", process.env.DODO_PAYMENTS_API_KEY ? "DODO_PAYMENTS_API_KEY" : process.env.DODO_API_KEY ? "DODO_API_KEY" : "none", "length:", trimmedKey.length, "starts_with:", trimmedKey.substring(0, 8) + "...");
    
    if (!trimmedKey) {
      return NextResponse.json({ error: "DODO API key is empty or missing." }, { status: 500 });
    }
    
    const dodoClient = new DodoPayments({
      bearerToken: trimmedKey,
      environment: (process.env.DODO_PAYMENTS_ENVIRONMENT === "live_mode" || process.env.DODO_PAYMENTS_ENVIRONMENT === "production") ? "live_mode" : "test_mode",
    });

    const session = await dodoClient.checkoutSessions.create({
      product_cart: [{ product_id: resolvedId, quantity: 1 }],
      customer: sharedCustomer,
      return_url: successUrl,
      cancel_url: cancelUrl,
      metadata: sharedMetadata,
    });

    const checkoutUrl = session.checkout_url;
    if (!checkoutUrl) {
      return NextResponse.json({ error: "Dodo did not return a checkout URL." }, { status: 502 });
    }

    console.log("[checkout] session created successfully", {
      checkoutUrl: checkoutUrl?.substring(0, 50) + "...",
      planType,
      resolvedId,
    });

    return NextResponse.json(
      {
        checkoutUrl,
        provider: "dodo",
        planType,
        isSubscription: planType !== "topup",
        productId: resolvedId,
      },
      { status: 200 }
    );
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("[/api/payments/checkout] Dodo error:", message, { error });
    return NextResponse.json({ error: "checkout_failed", detail: message }, { status: 502 });
  }
}