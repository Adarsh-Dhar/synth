import { NextRequest, NextResponse } from "next/server";

export async function POST(_req: NextRequest) {
  return NextResponse.json(
    {
      error: "send_funds_not_implemented",
      message: "Funding is expected to happen client-side with the connected Solana wallet.",
    },
    { status: 501 },
  );
}
