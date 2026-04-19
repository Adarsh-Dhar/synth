import { NextResponse } from "next/server";
import { PublicKey } from "@solana/web3.js";
import bs58 from "bs58";
import nacl from "tweetnacl";
import { prisma } from "@/lib/prisma";

const MAX_SKEW_MS = 5 * 60 * 1000;

export type AuthenticatedUser = {
  id: string;
  walletAddress: string;
};

function unauthorized(message: string): NextResponse {
  return NextResponse.json({ error: message }, { status: 401 });
}

export async function requireWalletAuth(req: Request): Promise<{ user: AuthenticatedUser | null; error: NextResponse | null }> {
  const wallet = (req.headers.get("x-synth-wallet") ?? "").trim();
  const timestampRaw = (req.headers.get("x-synth-timestamp") ?? "").trim();
  const signature = (req.headers.get("x-synth-signature") ?? "").trim();

  if (!wallet || !timestampRaw || !signature) {
    return { user: null, error: unauthorized("Missing wallet authentication headers.") };
  }

  const timestamp = Number(timestampRaw);
  if (!Number.isFinite(timestamp) || timestamp <= 0) {
    return { user: null, error: unauthorized("Invalid wallet authentication timestamp.") };
  }

  if (Math.abs(Date.now() - timestamp) > MAX_SKEW_MS) {
    return { user: null, error: unauthorized("Wallet authentication signature expired.") };
  }

  const message = `synth-auth:v1:${wallet}:${timestamp}`;

  try {
    const messageBytes = new TextEncoder().encode(message);
    const signatureBytes = bs58.decode(signature);
    const publicKey = new PublicKey(wallet);

    const ok = nacl.sign.detached.verify(messageBytes, signatureBytes, publicKey.toBytes());
    if (!ok) {
      return { user: null, error: unauthorized("Invalid wallet authentication signature.") };
    }
  } catch {
    return { user: null, error: unauthorized("Invalid wallet authentication payload.") };
  }

  const user = await prisma.user.findFirst({
    where: { walletAddress: wallet },
    select: { id: true, walletAddress: true },
  });

  if (!user) {
    return {
      user: null,
      error: unauthorized("Wallet is not registered. Call /api/users/sync first."),
    };
  }

  return { user, error: null };
}

export async function requireOwnedAgent(
  req: Request,
  agentId: string,
  options?: { includeFiles?: boolean; includeTradeLogs?: boolean; select?: Record<string, boolean> },
): Promise<{ user: AuthenticatedUser | null; agent: Record<string, unknown> | null; error: NextResponse | null }> {
  const auth = await requireWalletAuth(req);
  if (auth.error || !auth.user) {
    return { user: null, agent: null, error: auth.error };
  }

  const include: Record<string, unknown> = {};
  if (options?.includeFiles) include.files = { orderBy: { createdAt: "asc" } };
  if (options?.includeTradeLogs) include.tradeLogs = { orderBy: { createdAt: "desc" }, take: 50 };

  const agent = await prisma.agent.findFirst({
    where: { id: agentId, userId: auth.user.id },
    ...(options?.select ? { select: options.select } : { include }),
  });

  if (!agent) {
    return {
      user: auth.user,
      agent: null,
      error: NextResponse.json({ error: "Agent not found." }, { status: 404 }),
    };
  }

  return { user: auth.user, agent: agent as Record<string, unknown>, error: null };
}
