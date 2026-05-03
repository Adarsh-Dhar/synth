import { NextRequest, NextResponse } from "next/server";
import { RouteContext } from "@/lib/types";
import { requireEnterprisePlanForUser, requireOwnedAgent } from "@/lib/auth/server";
import { PrivateBrainService } from "@/lib/private-brain";

export async function POST(req: NextRequest, { params }: RouteContext) {
  try {
    const { agentId } = await params;
    const owned = await requireOwnedAgent(req, agentId, { select: { id: true } });
    if (owned.error || !owned.agent || !owned.user) {
      return owned.error ?? NextResponse.json({ error: "Agent not found." }, { status: 404 });
    }

    const enterprise = await requireEnterprisePlanForUser(owned.user.id);
    if (!enterprise.ok) {
      return enterprise.error;
    }

    await PrivateBrainService.disable(agentId, owned.user.id);
    return NextResponse.json({ ok: true }, { status: 200 });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    const status = message.includes("not configured") ? 404 : 500;
    return NextResponse.json({ error: message }, { status });
  }
}