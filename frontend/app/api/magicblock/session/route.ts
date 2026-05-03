/**
 * MagicBlock Session Endpoint
 *
 * Creates a new session by verifying the TEE validator is live and responsive.
 * Returns session metadata for the client to use for subsequent operations.
 */

import { NextRequest, NextResponse } from "next/server";
import { Connection } from "@solana/web3.js";
import { requireWalletAuth } from "@/lib/auth/server";
import {
  getValidatorEndpoint,
  getValidatorPubkey,
  isValidValidator,
} from "@/lib/validators-config";

export async function POST(req: NextRequest) {
  const auth = await requireWalletAuth(req);
  if (auth.error || !auth.user) {
    return auth.error ?? NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  }

  const body = (await req.json().catch(() => ({}))) as { agentId?: string; validator?: string };

  if (!body.agentId) {
    return NextResponse.json({ error: "agentId is required" }, { status: 400 });
  }

  const validator = body.validator ?? "devnet-tee.magicblock.app";

  // Validate the validator exists
  if (!isValidValidator(validator)) {
    return NextResponse.json(
      { error: `Unknown validator: ${validator}` },
      { status: 400 }
    );
  }

  const validatorPubkey = getValidatorPubkey(validator);
  const endpoint = getValidatorEndpoint(validator);

  // Verify the TEE validator is live and responsive
  let slot: number;
  try {
    const teeConn = new Connection(endpoint, { commitment: "confirmed" });
    slot = await teeConn.getSlot("confirmed");
    if (slot <= 0) {
      throw new Error("Invalid slot returned from validator");
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json(
      {
        error: `TEE validator unreachable: ${msg}`,
        validator,
        endpoint,
      },
      { status: 502 }
    );
  }

  return NextResponse.json(
    {
      sessionId: `mb_${body.agentId}_${Date.now()}`,
      validator,
      validatorPubkey,
      validatorEndpoint: endpoint,
      currentSlot: slot,
      delegated: false,
    },
    { status: 200 }
  );
}
