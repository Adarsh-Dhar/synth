// frontend/app/api/agents/[agentId]/start/route.ts
import { NextRequest, NextResponse } from "next/server";
import { RouteContext } from "@/lib/types";
import { requireOwnedAgent } from "@/lib/auth/server";
import { requireEnv } from "@/lib/env";
import { prisma } from "@/lib/prisma";

const WORKER_URL = process.env.WORKER_URL ?? "http://localhost:4001";
const MAX_RUNNING_BY_TIER: Record<string, number> = {
  FREE: 1,
  PRO: 5,
  ENTERPRISE: 25,
};

export async function POST(req: NextRequest, { params }: RouteContext) {
  const { agentId } = await params;

  try {
    const owned = await requireOwnedAgent(req, agentId, { includeFiles: true, enforceSubscription: true });
    if (owned.error || !owned.agent || !owned.user) {
      return owned.error ?? NextResponse.json({ error: "Agent not found." }, { status: 404 });
    }

    const agent = owned.agent as {
      envConfig?: string | null;
      configuration?: Record<string, unknown> | null;
      files?: Array<{ filepath?: string; content?: string }>;
    };
    const files = Array.isArray(agent.files)
      ? agent.files
          .filter((f) => typeof f.filepath === "string" && typeof f.content === "string")
          .map((f) => ({ filepath: f.filepath as string, content: f.content as string }))
      : [];

    if (files.length === 0) {
      return NextResponse.json({ error: "Agent has no files to run." }, { status: 400 });
    }

    const user = await prisma.user.findUnique({
      where: { id: owned.user.id },
      select: { subscriptionTier: true },
    });
    const tier = String(user?.subscriptionTier || "FREE").toUpperCase();
    const maxRunning = MAX_RUNNING_BY_TIER[tier] ?? MAX_RUNNING_BY_TIER.FREE;
    const runningCount = await prisma.agent.count({
      where: {
        userId: owned.user.id,
        status: { in: ["RUNNING", "STARTING"] },
      },
    });
    if (runningCount >= maxRunning) {
      return NextResponse.json(
        { error: `Running-agent limit reached for tier ${tier}.`, tier, maxRunning },
        { status: 402 },
      );
    }

    const workerSecret = requireEnv("WORKER_SECRET");
    const workerRes = await fetch(`${WORKER_URL}/agents/${agentId}/start`, {
      method:  "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization:  `Bearer ${workerSecret}`,
      },
      body: JSON.stringify({
        files,
        configuration: agent.configuration ?? {},
        envConfig: agent.envConfig ?? null,
      }),
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