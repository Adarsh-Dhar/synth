import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { RouteContext } from "@/lib/types";
import { requireOwnedAgent } from "@/lib/auth/server";

// ─── GET: Fetch a single agent's full details ─────────────────────────────────
export async function GET(_req: NextRequest, { params }: RouteContext) {
  try {
    const { agentId } = await params;
    const owned = await requireOwnedAgent(_req, agentId, { includeFiles: true, includeTradeLogs: true });
    if (owned.error || !owned.agent) {
      return owned.error ?? NextResponse.json({ error: "Agent not found." }, { status: 404 });
    }

    return NextResponse.json(owned.agent, { status: 200 });
  } catch {
    return NextResponse.json({ error: "Internal server error." }, { status: 500 });
  }
}

// ─── DELETE: Permanently destroy an agent ────────────────────────────────────
export async function DELETE(_req: NextRequest, { params }: RouteContext) {
  try {
    const { agentId } = await params;
    const owned = await requireOwnedAgent(_req, agentId, { select: { id: true } });
    if (owned.error || !owned.agent) {
      return owned.error ?? NextResponse.json({ error: "Agent not found." }, { status: 404 });
    }

    await prisma.agent.delete({ where: { id: agentId } });

    return NextResponse.json({ success: true }, { status: 200 });
  } catch {
    return NextResponse.json({ error: "Internal server error." }, { status: 500 });
  }
}