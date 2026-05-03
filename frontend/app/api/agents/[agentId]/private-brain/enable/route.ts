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

    const body = await req.json().catch(() => ({}));
    const memorySlotsRaw = body.memory_slots;
    const config = await PrivateBrainService.enable(agentId, owned.user.id, {
      validator: typeof body.validator === "string" ? body.validator : undefined,
      memorySlots: Number.isFinite(Number(memorySlotsRaw)) ? Number(memorySlotsRaw) : undefined,
      geofenceRegions: Array.isArray(body.geofence_regions) ? body.geofence_regions : undefined,
    });

    return NextResponse.json({ config }, { status: 200 });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    const status = message.startsWith("Unknown validator:") ? 400 : 500;
    return NextResponse.json({ error: message }, { status });
  }
}