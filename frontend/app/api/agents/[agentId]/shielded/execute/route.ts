/**
 * POST /api/agents/[agentId]/shielded/execute
 *
 * Execute an instruction against the TEE
 * This is called by the orchestrator or worker to submit shielded txs to the TEE RPC
 */

import { NextRequest, NextResponse } from "next/server";
import { RouteContext } from "@/lib/types";
import { requireOwnedAgent } from "@/lib/auth/server";
import { ShieldedExecutionService } from "@/lib/shielded-execution";

export async function POST(req: NextRequest, { params }: RouteContext) {
  try {
    const { agentId } = await params;
    const owned = await requireOwnedAgent(req, agentId, { select: { id: true } });
    if (owned.error || !owned.agent || !owned.user) {
      return owned.error ?? NextResponse.json({ error: "Agent not found." }, { status: 404 });
    }

    const body = await req.json().catch(() => ({}));
    const rawTxBase64 = String(body.instruction_tx ?? "").trim();

    if (!rawTxBase64) {
      return NextResponse.json({ error: "instruction_tx (base64) is required" }, { status: 400 });
    }

    const txSig = await ShieldedExecutionService.executeShielded(agentId, rawTxBase64);

    return NextResponse.json({ txSignature: txSig }, { status: 200 });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    const status = message.includes("not active") ? 400 : message.includes("unreachable") ? 502 : 500;
    return NextResponse.json({ error: message }, { status });
  }
}
