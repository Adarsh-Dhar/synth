import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

// GET /api/get-db-code
// Returns all agent code files for the public user (latest agent)
export async function GET() {
  try {
    const userId = "public-user";
    // Get the latest agent for the public user
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
