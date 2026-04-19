import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { RouteContext } from "@/lib/types";
import { requireOwnedAgent } from "@/lib/auth/server";

// ─── PATCH: Update an agent's status ─────────────────────────────────────────
// Valid transitions: STARTING → RUNNING → STOPPING → STOPPED, ERROR at any point
export async function PATCH(req: NextRequest, { params }: RouteContext) {
  try {
    const { agentId } = await params;
    const body = await req.json();
    const { status } = body;

    const owned = await requireOwnedAgent(req, agentId, { select: { id: true } });
    if (owned.error || !owned.agent) {
      return owned.error ?? NextResponse.json({ error: "Agent not found." }, { status: 404 });
    }

    const validStatuses = ["STARTING", "RUNNING", "STOPPING", "STOPPED", "ERROR"];
    if (!status || !validStatuses.includes(status)) {
      return NextResponse.json(
        { error: `Invalid status. Must be one of: ${validStatuses.join(", ")}` },
        { status: 400 }
      );
    }

    const updatedAgent = await prisma.agent.update({
      where: { id: agentId },
      data: { status },
    });

    return NextResponse.json(updatedAgent, { status: 200 });
  } catch (error: unknown) {
    console.error("[PATCH /api/agents/[agentId]/status] Error:", error);
    return NextResponse.json({ error: "Internal server error." }, { status: 500 });
  }
}