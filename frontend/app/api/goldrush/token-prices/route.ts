import { NextRequest, NextResponse } from "next/server";
import { requireWalletAuth } from "@/lib/auth/server";

const GOLDRUSH_BASE_URL = "https://api.covalenthq.com/v1";

type PriceMap = Record<string, number>;

function parseMints(input: string | null): string[] {
  if (!input) return [];
  return input
    .split(",")
    .map((m) => m.trim())
    .filter(Boolean);
}

export async function GET(req: NextRequest) {
  const auth = await requireWalletAuth(req);
  if (auth.error || !auth.user) {
    return auth.error ?? NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  }

  const apiKey = String(process.env.GOLDRUSH_API_KEY || "").trim();
  const network = String(process.env.GOLDRUSH_NETWORK_ID || "solana-mainnet").trim();
  const mints = parseMints(req.nextUrl.searchParams.get("mints"));

  if (mints.length === 0) {
    return NextResponse.json({ error: "Missing query param: mints" }, { status: 400 });
  }

  if (!apiKey) {
    return NextResponse.json({ error: "GoldRush API key is not configured." }, { status: 500 });
  }

  const result: PriceMap = {};

  await Promise.all(
    mints.map(async (mint) => {
      const url = `${GOLDRUSH_BASE_URL}/${network}/tokens/${encodeURIComponent(mint)}/price/`;
      const res = await fetch(url, {
        headers: { Authorization: `Bearer ${apiKey}` },
        cache: "no-store",
      });
      if (!res.ok) return;

      const json = (await res.json()) as { data?: { items?: Array<{ quote_rate?: number }> } };
      const price = json.data?.items?.[0]?.quote_rate;
      if (typeof price === "number" && Number.isFinite(price)) {
        result[mint] = price;
      }
    }),
  );

  return NextResponse.json({ pricesUsd: result, source: "goldrush" }, { status: 200 });
}
