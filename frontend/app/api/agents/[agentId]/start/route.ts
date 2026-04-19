// frontend/app/api/agents/[agentId]/start/route.ts
import { NextRequest, NextResponse } from "next/server";
import { RouteContext } from "@/lib/types";
import { requireOwnedAgent } from "@/lib/auth/server";
import { requireEnv } from "@/lib/env";

const WORKER_URL = process.env.WORKER_URL ?? "http://localhost:4001";

export async function POST(req: NextRequest, { params }: RouteContext) {
  const { agentId } = await params;

  try {
    const owned = await requireOwnedAgent(req, agentId, { select: { id: true } });
    if (owned.error || !owned.agent) {
      return owned.error ?? NextResponse.json({ error: "Agent not found." }, { status: 404 });
    }

    const workerSecret = requireEnv("WORKER_SECRET");
    const workerRes = await fetch(`${WORKER_URL}/agents/${agentId}/start`, {
      method:  "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization:  `Bearer ${workerSecret}`,
      },
    });

    const raw = await workerRes.text();
    let data: unknown = {};
    try {
      data = raw ? JSON.parse(raw) : {};
    } catch {
      data = { error: raw || "Worker returned a non-JSON response" };
    }

    return NextResponse.json(data, { status: workerRes.ok ? 200 : workerRes.status });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json(
      { error: `Could not reach worker: ${message}` },
      { status: 502 },
    );
  }
}