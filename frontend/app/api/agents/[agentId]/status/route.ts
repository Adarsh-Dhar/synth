import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { RouteContext } from "@/lib/types";

// ─── PATCH: Update an agent's status ─────────────────────────────────────────
// Valid transitions: STARTING → RUNNING → STOPPING → STOPPED, ERROR at any point
export async function PATCH(req: NextRequest, { params }: RouteContext) {
  try {
    const { agentId } = await params;
    const body = await req.json();
    const { status } = body;

    const validStatuses = ["STARTING", "RUNNING", "STOPPING", "STOPPED", "ERROR"];
    if (!status || !validStatuses.includes(status)) {
      return NextResponse.json(
        { error: `Invalid status. Must be one of: ${validStatuses.join(", ")}` },
        { status: 400 }
      );
    }

    const existing = await prisma.agent.findUnique({
      where: { id: agentId },
      select: { id: true, name: true },
    });

    if (!existing) {
      return NextResponse.json(
        { error: `Agent with id "${agentId}" not found.` },
        { status: 404 }
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