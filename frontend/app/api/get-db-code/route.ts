import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireWalletAuth } from "@/lib/auth/server";

// GET /api/get-db-code
// Returns all agent code files for the authenticated user (latest agent)
export async function GET(req: Request) {
  try {
    const auth = await requireWalletAuth(req);
    if (auth.error || !auth.user) {
      return auth.error ?? NextResponse.json({ error: "Unauthorized." }, { status: 401 });
    }

    const userId = auth.user.id;
    // Get the latest agent for the authenticated user
    const agent = await prisma.agent.findFirst({
      where: { userId },
      orderBy: { createdAt: "desc" },
      include: { files: true },
    });

    if (!agent) {
      return NextResponse.json({ error: "No agent found for user." }, { status: 404 });
    }

    // Return the files as posted (filepath, content, language)
    return NextResponse.json({
      agentId: agent.id,
      name: agent.name,
      configuration: agent.configuration,
      files: agent.files.map(f => ({
        filepath: f.filepath,
        content: f.content,
        language: f.language,
      })),
      createdAt: agent.createdAt,
      updatedAt: agent.updatedAt,
    });
  } catch (error) {
    const err = error;
    console.error("[GET /api/get-db-code] Error:", err);
    return NextResponse.json(
      { error: err || String(error) || null },
      { status: 500 }
    );
  }
}
