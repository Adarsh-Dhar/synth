import { NextRequest, NextResponse } from "next/server";
import { requireWalletAuth } from "@/lib/auth/server";

export async function POST(req: NextRequest) {
  const auth = await requireWalletAuth(req);
  if (auth.error || !auth.user) {
    return auth.error ?? NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  }

  const body = (await req.json().catch(() => ({}))) as { agentId?: string };
  if (!body.agentId) {
    return NextResponse.json({ error: "agentId is required" }, { status: 400 });
  }

  return NextResponse.json(
    {
      sessionId: `mb_${body.agentId}_${Date.now()}`,
      validator: process.env.MAGICBLOCK_TEE_VALIDATOR || "",
      delegated: false,
      mode: "scaffold",
    },
    { status: 200 },
  );
}
