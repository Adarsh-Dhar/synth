/**
 * GET /api/agents/[agentId]/private-brain/read-state
 *
 * Read encrypted state from the TEE RPC
 * Only works if the account is actively delegated
 */

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

    const stateData = await PrivateBrainService.readStateFromTee(agentId, owned.user.id);

    // Return as base64-encoded string
    const stateBase64 = stateData ? stateData.toString("base64") : null;

    return NextResponse.json(
      { state: stateBase64, stateLength: stateData?.length ?? 0 },
      { status: 200 }
    );
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    const status = message.includes("unreachable") ? 502 : 500;
    return NextResponse.json({ error: message }, { status });
  }
}
