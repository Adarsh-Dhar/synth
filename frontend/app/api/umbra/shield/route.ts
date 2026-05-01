import { NextRequest, NextResponse } from "next/server";
import { requireWalletAuth } from "@/lib/auth/server";

export async function POST(req: NextRequest) {
  const auth = await requireWalletAuth(req);
  if (auth.error || !auth.user) {
    return auth.error ?? NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  }

  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  return NextResponse.json(
    {
      ok: true,
      operation: "shield",
      network: process.env.UMBRA_NETWORK || "mainnet-beta",
      programAddress: process.env.UMBRA_PROGRAM_ADDRESS || "",
      request: body,
      mode: "scaffold",
    },
    { status: 200 },
  );
}
