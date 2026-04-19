import { NextRequest, NextResponse } from "next/server";
import { requireWalletAuth } from "@/lib/auth/server";

export async function POST(req: NextRequest) {
  const auth = await requireWalletAuth(req);
  if (auth.error || !auth.user) {
    return auth.error ?? NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  }

  const body = (await req.json().catch(() => ({}))) as { viewerAddress?: string };
  if (!body.viewerAddress) {
    return NextResponse.json({ error: "viewerAddress is required" }, { status: 400 });
  }

  return NextResponse.json(
    {
      ok: true,
      viewerAddress: body.viewerAddress,
      grantedAt: new Date().toISOString(),
      mode: "scaffold",
    },
    { status: 200 },
  );
}
