import { NextRequest, NextResponse } from "next/server";
import { RouteContext } from "@/lib/types";
import { requireEnterprisePlanForUser, requireOwnedAgent } from "@/lib/auth/server";
import { ShieldedExecutionService } from "@/lib/shielded-execution";

export async function POST(req: NextRequest, { params }: RouteContext) {
  try {
    const { agentId } = await params;
    const owned = await requireOwnedAgent(req, agentId, { select: { id: true } });
    if (owned.error || !owned.agent || !owned.user) {
      return owned.error ?? NextResponse.json({ error: "Agent not found." }, { status: 404 });
    }

    const enterprise = await requireEnterprisePlanForUser(owned.user.id);
    if (!enterprise.ok) return enterprise.error;

    const body = await req.json().catch(() => ({}));
    const config = await ShieldedExecutionService.enable(agentId, owned.user.id, {
      validator: typeof body.validator === "string" ? body.validator : undefined,
      shieldStrategyLogic: body.shield_strategy_logic ?? body.shieldStrategyLogic,
      shieldIntent: body.shield_intent ?? body.shieldIntent,
      shieldIntermediateStates: body.shield_intermediate_states ?? body.shieldIntermediateStates,
      settlementMode: body.settlement_mode ?? body.settlementMode,
      settlementIntervalMs: Number.isFinite(Number(body.settlement_interval_ms ?? body.settlementIntervalMs))
        ? Number(body.settlement_interval_ms ?? body.settlementIntervalMs)
        : undefined,
    });

    return NextResponse.json({ config }, { status: 200 });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    const status = message.startsWith("Unknown validator:") ? 400 : 500;
    return NextResponse.json({ error: message }, { status });
  }
}