import { NextRequest, NextResponse } from "next/server";
import { requireWalletAuth } from "@/lib/auth/server";

const GOLDRUSH_BASE_URL = "https://api.covalenthq.com/v1";

export async function GET(req: NextRequest) {
  const auth = await requireWalletAuth(req);
  if (auth.error || !auth.user) {
    return auth.error ?? NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  }

  const wallet = String(req.nextUrl.searchParams.get("wallet") || auth.user.walletAddress || "").trim();
  const network = String(process.env.GOLDRUSH_NETWORK_ID || "solana-mainnet").trim();
  const apiKey = String(process.env.GOLDRUSH_API_KEY || "").trim();

  if (!wallet) {
    return NextResponse.json({ error: "Missing wallet address." }, { status: 400 });
  }

  if (!apiKey) {
    return NextResponse.json({ error: "GoldRush API key is not configured." }, { status: 500 });
  }

  const url = `${GOLDRUSH_BASE_URL}/${network}/address/${encodeURIComponent(wallet)}/balances_v2/`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${apiKey}` },
    cache: "no-store",
  });

  if (!res.ok) {
    const body = await res.text();
    return NextResponse.json({ error: "Failed to fetch portfolio.", detail: body.slice(0, 200) }, { status: 502 });
  }

  const json = await res.json();
  return NextResponse.json({ source: "goldrush", wallet, network, portfolio: json }, { status: 200 });
}
