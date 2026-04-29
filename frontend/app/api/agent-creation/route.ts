import { NextRequest, NextResponse } from "next/server";

export async function POST(_req: NextRequest) {
  return NextResponse.json(
    {
      error: "agent_creation_not_implemented",
      message: "This compatibility route is not wired yet. Use /api/generate-bot for agent generation.",
    },
    { status: 501 },
  );
}
