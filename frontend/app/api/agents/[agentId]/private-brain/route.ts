import { NextRequest, NextResponse } from "next/server";
import { RouteContext } from "@/lib/types";
import { requireEnterprisePlanForUser, requireOwnedAgent } from "@/lib/auth/server";
import { PrivateBrainService } from "@/lib/private-brain";

export async function GET(req: NextRequest, { params }: RouteContext) {
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

    const config = await PrivateBrainService.getConfig(agentId, owned.user.id);
    return NextResponse.json({ config: config ?? null }, { status: 200 });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}