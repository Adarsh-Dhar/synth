/**
 * frontend/app/api/signing-relay/[requestId]/route.ts
 */

import { NextRequest, NextResponse } from "next/server";
import { getRequest, resolveRequest } from "@/lib/signing-relay-db";

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ requestId: string }> }
) {
  const { requestId } = await params;
  const request = await getRequest(requestId);

  if (!request) {
    return NextResponse.json({ error: "Request not found or expired." }, { status: 404 });
  }

  return NextResponse.json(request, { headers: { "Cache-Control": "no-store" } });
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ requestId: string }> }
) {
  try {
    const { requestId } = await params;
    const body = await req.json();
    const { txHash, error } = body;

    const resolved = await resolveRequest(requestId, {
      txHash: txHash ?? undefined,
      error: error ?? undefined,
    });

    if (!resolved) {
      return NextResponse.json({ error: "Request not found, already resolved, or timed out." }, { status: 409 });
    }

    return NextResponse.json({ success: true }, { status: 200 });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
