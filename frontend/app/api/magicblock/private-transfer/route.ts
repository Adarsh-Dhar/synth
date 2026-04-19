import { NextRequest, NextResponse } from "next/server";
import { requireWalletAuth } from "@/lib/auth/server";

export async function POST(req: NextRequest) {
  const auth = await requireWalletAuth(req);
  if (auth.error || !auth.user) {
    return auth.error ?? NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  }

  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const base = String(process.env.MAGICBLOCK_PRIVATE_PAYMENTS_BASE_URL || "").trim();
  if (!base) {
    return NextResponse.json({ error: "MAGICBLOCK_PRIVATE_PAYMENTS_BASE_URL is not configured" }, { status: 500 });
  }

  const upstream = await fetch(`${base.replace(/\/+$/, "")}/transfer`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  const text = await upstream.text();
  return new NextResponse(text, {
    status: upstream.status,
    headers: { "Content-Type": "application/json" },
  });
}
