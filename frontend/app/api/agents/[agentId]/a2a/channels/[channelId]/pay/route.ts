import { NextRequest, NextResponse } from "next/server";
import { RouteContext } from "@/lib/types";
import { requireOwnedAgent } from "@/lib/auth/server";
import { A2APaymentService } from "@/lib/a2a-payment";

export async function POST(req: NextRequest, { params }: RouteContext) {
  try {
    const { agentId, channelId } = await params;
    const owned = await requireOwnedAgent(req, agentId, { select: { id: true } });
    if (owned.error || !owned.agent || !owned.user) {
      return owned.error ?? NextResponse.json({ error: "Agent not found." }, { status: 404 });
    }

    const body = await req.json().catch(() => ({}));
    const payment = await A2APaymentService.pay(
      channelId,
      agentId,
      String(body.payee_bot_id ?? body.payeeAgentId ?? "").trim(),
      Number(body.amount_micro ?? body.amountMicro ?? 0),
      String(body.currency ?? "USDC"),
      String(body.purpose ?? "").trim(),
      String(body.idempotency_key ?? body.idempotencyKey ?? "").trim()
    );

    return NextResponse.json({ payment }, { status: 200 });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}