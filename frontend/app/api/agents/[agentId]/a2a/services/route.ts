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
    const service = await A2APaymentService.registerService(agentId, owned.user.id, {
      serviceType: String(body.serviceType ?? "custom") as any,
      name: String(body.name ?? "").trim(),
      description: typeof body.description === "string" ? body.description : undefined,
      endpointUrl: typeof body.endpointUrl === "string" ? body.endpointUrl : undefined,
      currency: body.currency === "SOL" ? "SOL" : "USDC",
      pricePerCallMicro: Number.isFinite(Number(body.pricePerCallMicro)) ? Number(body.pricePerCallMicro) : undefined,
      pricePerSecondMicro: Number.isFinite(Number(body.pricePerSecondMicro)) ? Number(body.pricePerSecondMicro) : undefined,
      isPublic: Boolean(body.isPublic),
      requiresWhitelist: Boolean(body.requiresWhitelist),
    });

    return NextResponse.json({ service }, { status: 200 });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function GET(req: NextRequest, { params }: RouteContext) {
  try {
    const { agentId } = await params;
    const owned = await requireOwnedAgent(req, agentId, { select: { id: true } });
    if (owned.error || !owned.agent || !owned.user) {
      return owned.error ?? NextResponse.json({ error: "Agent not found." }, { status: 404 });
    }

    const serviceType = new URL(req.url).searchParams.get("type") ?? undefined;
    const services = await A2APaymentService.listPublicServices(serviceType);
    return NextResponse.json({ services }, { status: 200 });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}