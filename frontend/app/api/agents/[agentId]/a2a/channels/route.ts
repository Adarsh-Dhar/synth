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

    const body = await req.json().catch(() => ({}));
    const channel = await A2APaymentService.openChannel(
      agentId,
      String(body.payee_bot_id ?? body.payeeAgentId ?? "").trim(),
      typeof body.service_id === "string" ? body.service_id : typeof body.serviceId === "string" ? body.serviceId : null,
      {
        currency: body.currency === "SOL" ? "SOL" : "USDC",
        maxPerTxMicro: Number.isFinite(Number(body.max_per_tx_micro ?? body.maxPerTxMicro))
          ? Number(body.max_per_tx_micro ?? body.maxPerTxMicro)
          : undefined,
        dailyCapMicro: Number.isFinite(Number(body.daily_cap_micro ?? body.dailyCapMicro))
          ? Number(body.daily_cap_micro ?? body.dailyCapMicro)
          : undefined,
      }
    );

    return NextResponse.json({ channel }, { status: 200 });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}