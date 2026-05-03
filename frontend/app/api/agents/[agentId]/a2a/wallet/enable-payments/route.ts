import { NextRequest, NextResponse } from "next/server";
import { RouteContext } from "@/lib/types";
import { requireOwnedAgent } from "@/lib/auth/server";
import { A2APaymentService } from "@/lib/a2a-payment";

export async function POST(req: NextRequest, { params }: RouteContext) {
  try {
    const { agentId } = await params;
    const owned = await requireOwnedAgent(req, agentId, { select: { id: true } });
    if (owned.error || !owned.agent || !owned.user) {
      return owned.error ?? NextResponse.json({ error: "Agent not found." }, { status: 404 });
    }

    const apiKey = await A2APaymentService.enablePrivatePayments(agentId, owned.user.id);
    return NextResponse.json(
      { api_key: apiKey, warning: "Store this key securely — it will not be shown again." },
      { status: 200 }
    );
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}