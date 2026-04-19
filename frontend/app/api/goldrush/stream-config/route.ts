import { NextRequest, NextResponse } from "next/server";
import { requireWalletAuth } from "@/lib/auth/server";

const SUPPORTED_EVENT_TYPES = ["lp_pull", "drainer_approval", "phishing_airdrop"] as const;

type SupportedEventType = (typeof SUPPORTED_EVENT_TYPES)[number];

function parseDefaultFilters(raw: string): SupportedEventType[] {
  const parsed = raw
    .split(",")
    .map((part) => part.trim())
    .filter((part): part is SupportedEventType =>
      SUPPORTED_EVENT_TYPES.includes(part as SupportedEventType),
    );

  return parsed.length > 0 ? parsed : [...SUPPORTED_EVENT_TYPES];
}

export async function GET(req: NextRequest) {
  const auth = await requireWalletAuth(req);
  if (auth.error || !auth.user) {
    return auth.error ?? NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  }

  const upstreamStreamUrl = String(
    process.env.GOLDRUSH_STREAM_URL || process.env.NEXT_PUBLIC_GOLDRUSH_STREAM_URL || "",
  ).trim();

  const defaultFilters = parseDefaultFilters(String(process.env.GOLDRUSH_STREAM_EVENTS || ""));

  return NextResponse.json(
    {
      streamProxyUrl: "/api/goldrush/streaming-events",
      upstreamStreamUrl,
      supportedEventTypes: SUPPORTED_EVENT_TYPES,
      defaultEventTypes: defaultFilters,
    },
    {
      status: 200,
      headers: { "Cache-Control": "no-store" },
    },
  );
}
