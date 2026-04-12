import { NextRequest, NextResponse } from "next/server";
import { RouteContext } from "@/lib/types";

const WORKER_URL = process.env.WORKER_URL ?? "http://localhost:4001";
const WORKER_SECRET = process.env.WORKER_SECRET ?? "dev-worker-secret";

export async function GET(req: NextRequest, { params }: RouteContext) {
  const { agentId } = await params;
  const since = req.nextUrl.searchParams.get("since");

  try {
    const url = new URL(`${WORKER_URL}/agents/${agentId}/logs`);
    if (since) {
      url.searchParams.set("since", since);
    }

    const workerRes = await fetch(url.toString(), {
      method: "GET",
      headers: {
        Authorization: `Bearer ${WORKER_SECRET}`,
      },
    });

    if (!workerRes.ok) {
      const body = await workerRes.text().catch(() => "");
      console.error(`[terminal-logs] Worker returned ${workerRes.status} for ${agentId}: ${body}`);
      return NextResponse.json({ agentId, entries: [] }, { status: 200 });
    }

    const data = await workerRes.json();
    const entries = Array.isArray(data?.entries) ? data.entries : [];

    return NextResponse.json(
      { agentId, entries },
      {
        status: 200,
        headers: { "Cache-Control": "no-store" },
      }
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[terminal-logs] Error proxying logs for ${agentId}:`, err);
    return NextResponse.json(
      { agentId, entries: [], error: message },
      { status: 200 }
    );
  }
}