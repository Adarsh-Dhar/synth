import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireEnv } from "@/lib/env";

// ─── POST /api/internal/webhooks ─────────────────────────────────────────────
// Private channel for the off-chain worker to push completed trade results.
// Requires a shared secret in the Authorization header.
export async function POST(req: NextRequest) {
  try {
    const dodoSignature = req.headers.get("x-dodo-signature");
    if (dodoSignature) {
      const rawBody = await req.text();
      const dodoSecret = requireEnv("DODO_WEBHOOK_SECRET");
      const proxyResponse = await fetch(new URL("/api/internal/dodo-payments", req.url), {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${dodoSecret}`,
          "x-dodo-signature": dodoSignature,
          ...(req.headers.get("x-dodo-timestamp")
            ? { "x-dodo-timestamp": req.headers.get("x-dodo-timestamp") as string }
            : {}),
        },
        body: rawBody,
      });

      const responseBody = await proxyResponse.text();
      return new NextResponse(responseBody, {
        status: proxyResponse.status,
        headers: {
          "content-type": proxyResponse.headers.get("content-type") ?? "application/json",
        },
      });
    }

    // ── 1. Security gate ──────────────────────────────────────────────────────
    const authHeader = req.headers.get("authorization");
    const expectedToken = `Bearer ${requireEnv("INTERNAL_WEBHOOK_SECRET")}`;

    if (!authHeader || authHeader !== expectedToken) {
      console.warn("[/api/internal/webhooks] unauthorized attempt blocked.");
      return NextResponse.json({ error: "unauthorized." }, { status: 401 });
    }

    // ── 2. Parse & validate payload ───────────────────────────────────────────
    const body = await req.json();
    const {
      agentId,
      txHash,
      tokenIn,
      tokenOut,
      amountIn,
      amountOut,
      profitUsd,
      executionTimeMs,
      status, // optional: update agent status alongside the log
    } = body;

    if (!agentId) {
      return NextResponse.json({ error: "agentId is required." }, { status: 400 });
    }

    // All TradeLog fields are required
    const requiredTradeFields = [
      "txHash", "tokenIn", "tokenOut",
      "amountIn", "amountOut", "profitUsd", "executionTimeMs",
    ] as const;

    const missingFields = requiredTradeFields.filter(
      (k) => body[k] === undefined || body[k] === null
    );
    if (missingFields.length > 0) {
      return NextResponse.json(
        { error: `Missing required fields: ${missingFields.join(", ")}.` },
        { status: 400 }
      );
    }

    if (typeof executionTimeMs !== "number" || executionTimeMs < 0) {
      return NextResponse.json(
        { error: "executionTimeMs must be a non-negative integer." },
        { status: 400 }
      );
    }

    // Validate optional status update
    const validStatuses = ["STARTING", "RUNNING", "STOPPING", "STOPPED", "ERROR"];
    if (status !== undefined && !validStatuses.includes(status)) {
      return NextResponse.json(
        { error: `Invalid status. Must be one of: ${validStatuses.join(", ")}` },
        { status: 400 }
      );
    }

    // ── 3. Confirm agent exists ───────────────────────────────────────────────
    const agent = await prisma.agent.findUnique({
      where: { id: agentId },
      select: { id: true },
    });

    if (!agent) {
      return NextResponse.json(
        { error: `Agent with id "${agentId}" not found.` },
        { status: 404 }
      );
    }

    // ── 4. Write trade log (+ optionally update agent status) atomically ──────
    await prisma.$transaction(async (tx) => {
      await tx.tradeLog.create({
        data: {
          agentId,
          txHash,
          tokenIn,
          tokenOut,
          amountIn:       String(amountIn),
          amountOut:      String(amountOut),
          profitUsd:      String(profitUsd),
          executionTimeMs: Math.round(executionTimeMs),
        },
      });

      if (status) {
        await tx.agent.update({
          where: { id: agentId },
          data: { status },
        });
      }
    });

    // ── 5. Acknowledge ────────────────────────────────────────────────────────
    return NextResponse.json({ success: true }, { status: 200 });
  } catch (error: unknown) {
    // Duplicate txHash
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
    console.error("[/api/internal/webhooks] Error:", error);
    return NextResponse.json({ error: "Internal server error." }, { status: 500 });
  }
}