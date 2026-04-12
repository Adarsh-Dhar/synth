/**
 * frontend/app/api/signing-relay/route.ts
 */

import { NextRequest, NextResponse } from "next/server";
import { addRequest, getPending } from "@/lib/signing-relay-db";

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const {
      network,
      moduleAddress,
      moduleName,
      functionName,
      typeArgs = [],
      args = [],
      programId,
      instructionData,
      accounts,
      rawTx,
    } = body;

    // Accept either legacy Solana move-style request OR a Solana-style request
    const hasMoveShape = moduleAddress && moduleName && functionName;
    const hasSolanaShape = programId && (instructionData || rawTx);

    if (!hasMoveShape && !hasSolanaShape) {
      return NextResponse.json({ error: "Provide either move-style (moduleAddress/moduleName/functionName) or solana-style (programId + instructionData/rawTx) request." }, { status: 400 });
    }

    const id = crypto.randomUUID();
    const request = await addRequest(id, {
      network: network ?? "solana",
      moduleAddress: moduleAddress ?? undefined,
      moduleName: moduleName ?? undefined,
      functionName: functionName ?? undefined,
      typeArgs: Array.isArray(typeArgs) ? typeArgs : [],
      args: Array.isArray(args) ? args : [],
      programId: programId ?? undefined,
      instructionData: instructionData ?? undefined,
      accounts: Array.isArray(accounts) ? accounts : undefined,
      rawTx: rawTx ?? undefined,
    });

    return NextResponse.json({ requestId: id, status: request.status }, { status: 201, headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}

export async function GET() {
  const pending = await getPending();
  return NextResponse.json({ requests: pending }, { headers: { "Cache-Control": "no-store" } });
}
