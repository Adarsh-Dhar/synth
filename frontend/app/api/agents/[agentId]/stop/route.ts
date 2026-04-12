// frontend/app/api/agents/[agentId]/stop/route.ts
import { NextRequest, NextResponse } from "next/server";
import { RouteContext } from "@/lib/types";

const WORKER_URL = process.env.WORKER_URL ?? "http://localhost:4001";
const WORKER_SECRET = process.env.WORKER_SECRET ?? "dev-worker-secret";

export async function POST(_req: NextRequest, { params }: RouteContext) {
  const { agentId } = await params;

  try {
    const workerRes = await fetch(`${WORKER_URL}/agents/${agentId}/stop`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${WORKER_SECRET}`,
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
