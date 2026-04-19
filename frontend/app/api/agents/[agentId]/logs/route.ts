import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { RouteContext } from "@/lib/types";
import { requireOwnedAgent } from "@/lib/auth/server";

// ─── GET: Fetch the last N trade logs for an agent ───────────────────────────
export async function GET(req: NextRequest, { params }: RouteContext) {
  try {
    const { agentId } = await params;

    const owned = await requireOwnedAgent(req, agentId, { select: { id: true } });
    if (owned.error || !owned.agent) {
      return owned.error ?? NextResponse.json({ error: "Agent not found." }, { status: 404 });
    }

    const { searchParams } = new URL(req.url);
    const limitParam = searchParams.get("limit");
    const limit = limitParam ? Math.min(parseInt(limitParam, 10), 50) : 50;

    const logs = await prisma.tradeLog.findMany({
      where: { agentId },
      orderBy: { createdAt: "desc" },
      take: limit,
    });

    return NextResponse.json(logs, {
      status: 200,
      headers: { "Cache-Control": "no-store" },
    });
  } catch {
    return NextResponse.json({ error: "Internal server error." }, { status: 500 });
  }
}

// ─── POST: Record a new trade log entry ──────────────────────────────────────
export async function POST(req: NextRequest, { params }: RouteContext) {
  try {
    const { agentId } = await params;
    const owned = await requireOwnedAgent(req, agentId, { select: { id: true } });
    if (owned.error || !owned.agent) {
      return owned.error ?? NextResponse.json({ error: "Agent not found." }, { status: 404 });
    }

    const body = await req.json();

    const {
      txHash,
      tokenIn,
      tokenOut,
      amountIn,
      amountOut,
      profitUsd,
      executionTimeMs,
    } = body;

    // Validate required fields
    const missing = (
      ["txHash", "tokenIn", "tokenOut", "amountIn", "amountOut", "profitUsd", "executionTimeMs"] as const
    ).filter((k) => body[k] === undefined || body[k] === null);

    if (missing.length > 0) {
      return NextResponse.json(
        { error: `Missing required fields: ${missing.join(", ")}` },
        { status: 400 }
      );
    }

    if (typeof executionTimeMs !== "number" || executionTimeMs < 0) {
      return NextResponse.json(
        { error: "executionTimeMs must be a non-negative integer." },
        { status: 400 }
      );
    }

    const log = await prisma.tradeLog.create({
      data: {
        agentId,
        txHash,
        tokenIn,
        tokenOut,
        amountIn: String(amountIn),
        amountOut: String(amountOut),
        profitUsd: String(profitUsd),
        executionTimeMs: Math.round(executionTimeMs),
      },
    });

    return NextResponse.json(log, { status: 201 });
  } catch (error: unknown) {
    // Unique constraint violation on txHash
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      (error as { code: string }).code === "P2002"
    ) {
      return NextResponse.json(
        { error: "A trade log with this txHash already exists." },
        { status: 409 }
      );
    }
    return NextResponse.json({ error: "Internal server error." }, { status: 500 });
  }
}