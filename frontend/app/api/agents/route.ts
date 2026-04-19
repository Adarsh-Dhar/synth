import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireWalletAuth } from "@/lib/auth/server";

// ─── GET: List all agents for a user ─────────────────────────────────────────
export async function GET(req: NextRequest) {
  try {
    const auth = await requireWalletAuth(req);
    if (auth.error || !auth.user) {
      return auth.error ?? NextResponse.json({ error: "Unauthorized." }, { status: 401 });
    }

    const agents = await prisma.agent.findMany({
      where: { userId: auth.user.id },
      orderBy: { createdAt: "desc" },
      include: {
        files: {
          orderBy: { createdAt: "desc" },
          take: 1,
        },
        tradeLogs: {
          orderBy: { createdAt: "desc" },
          take: 1,
        },
      },
    });

    return NextResponse.json(agents, { status: 200 });
  } catch (error: unknown) {
    console.error("[GET /api/agents] Error:", error);
    return NextResponse.json(
      { error: "Internal server error." },
      { status: 500 }
    );
  }
}

// ─── POST: Deploy a new agent ─────────────────────────────────────────────────
export async function POST(req: NextRequest) {
  try {
    const auth = await requireWalletAuth(req);
    if (auth.error || !auth.user) {
      return auth.error ?? NextResponse.json({ error: "Unauthorized." }, { status: 401 });
    }

    const body = await req.json();
    const {
      name,
      configuration,
      walletAddress,
    } = body;

    if (!name) {
      return NextResponse.json(
        { error: "Missing required field: name." },
        { status: 400 }
      );
    }

    const userExists = auth.user;

    if (!userExists) {
      return NextResponse.json(
        { error: "Authenticated user not found." },
        { status: 404 }
      );
    }

    const agent = await prisma.agent.create({
      data: {
        userId: userExists.id,
        name,
        status: "STOPPED",
        walletAddress:
          (typeof walletAddress === "string" ? walletAddress.trim() : "") ||
          String(userExists.walletAddress || "").trim(),
        configuration: configuration ?? null,
      },
    });

    return NextResponse.json(agent, { status: 201 });
  } catch (error: unknown) {
    console.error("[POST /api/agents] Error:", error);
    return NextResponse.json(
      { error: "Internal server error." },
      { status: 500 }
    );
  }
}