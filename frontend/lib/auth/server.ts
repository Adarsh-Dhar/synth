/**
 * frontend/lib/auth/server.ts  (updated)
 *
 * Verifies incoming requests from BOTH auth methods:
 *   1. Solana wallet (existing): x-synth-wallet + x-synth-timestamp + x-synth-signature
 *   2. Privy JWT (new):          x-synth-privy-token + x-synth-privy-user
 *
 * The Privy verification path uses the server-side PrivyClient SDK.
 *
 * Install: npm install @privy-io/server-auth
 *
 * Required env vars (server-side only):
 *   NEXT_PUBLIC_PRIVY_APP_ID   (shared with client)
 *   PRIVY_APP_SECRET           (from Privy dashboard — never expose to client)
 */

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

type SubscriptionRecord = {
  status: string;
  validUntil: Date | null;
};

function unauthorized(message: string): NextResponse {
  return NextResponse.json({ error: message }, { status: 401 });
}

// ─── Lazy Privy client (avoids crashing if env vars aren't set) ───────────────

let _privyClient: import("@privy-io/server-auth").PrivyClient | null = null;

async function getPrivyClient() {
  if (_privyClient) return _privyClient;

  const appId = process.env.NEXT_PUBLIC_PRIVY_APP_ID?.trim();
  const secret = process.env.PRIVY_APP_SECRET?.trim();

  if (!appId || !secret) return null;

  const { PrivyClient } = await import("@privy-io/server-auth");
  _privyClient = new PrivyClient(appId, secret);
  return _privyClient;
}

// ─── Verify Privy JWT ─────────────────────────────────────────────────────────

async function verifyPrivyToken(
  token: string,
  privyUserId: string
): Promise<{ walletAddress: string; privyUserId: string } | null> {
  const client = await getPrivyClient();
  if (!client) return null;

  try {
    const claims = await client.verifyAuthToken(token);
    if (claims.userId !== privyUserId) return null;

    // Resolve wallet address from Privy user record
    const privyUser = await client.getUser(privyUserId);
    const solanaWallet = privyUser.linkedAccounts?.find(
      (a) => a.type === "wallet" && a.chainType === "solana"
    ) as { address?: string } | undefined;

    const walletAddress = solanaWallet?.address ?? `privy:${privyUserId}`;
    return { walletAddress, privyUserId };
  } catch {
    return null;
  }
}

// ─── Upsert Privy user in our DB ──────────────────────────────────────────────

async function upsertPrivyUser(
  privyUserId: string,
  walletAddress: string
): Promise<AuthenticatedUser | null> {
  const syntheticId = `privy:${privyUserId}`;

  // Check if a user record already exists for this Privy identity
  const existing = await prisma.user.findFirst({
    where: {
      OR: [
        { id: syntheticId },
        ...(walletAddress.startsWith("privy:") ? [] : [{ walletAddress }]),
      ],
    },
    select: { id: true, walletAddress: true },
  });

  if (existing) return existing;

  // Create a new user record
  const emailSafe = privyUserId.replace(/[^a-zA-Z0-9._-]/g, "_");
  try {
    const user = await prisma.user.create({
      data: {
        id: syntheticId,
        email: `${emailSafe}@privy.local`,
        walletAddress,
      },
      select: { id: true, walletAddress: true },
    });
    return user;
  } catch {
    // Race condition: try findFirst again
    return prisma.user.findFirst({
      where: { id: syntheticId },
      select: { id: true, walletAddress: true },
    });
  }
}

// ─── Main auth gate ───────────────────────────────────────────────────────────

export async function requireWalletAuth(
  req: Request
): Promise<{ user: AuthenticatedUser | null; error: NextResponse | null }> {
  // ── Path 1: Privy JWT (OAuth users) ──────────────────────────────────────
  const privyToken = (req.headers.get("x-synth-privy-token") ?? "").trim();
  const privyUserId = (req.headers.get("x-synth-privy-user") ?? "").trim();

  if (privyToken && privyUserId) {
    const verified = await verifyPrivyToken(privyToken, privyUserId);
    if (!verified) {
      return { user: null, error: unauthorized("Invalid Privy authentication token.") };
    }

    const user = await upsertPrivyUser(verified.privyUserId, verified.walletAddress);
    if (!user) {
      return { user: null, error: unauthorized("Failed to resolve user from Privy identity.") };
    }

    return { user, error: null };
  }

  // ── Path 2: Wallet signature (existing flow) ──────────────────────────────
  const wallet = (req.headers.get("x-synth-wallet") ?? "").trim();
  const timestampRaw = (req.headers.get("x-synth-timestamp") ?? "").trim();
  const signature = (req.headers.get("x-synth-signature") ?? "").trim();

  if (!wallet || !timestampRaw || !signature) {
    return {
      user: null,
      error: unauthorized(
        "Missing authentication headers. " +
          "Provide either Privy token headers (x-synth-privy-token, x-synth-privy-user) " +
          "or wallet headers (x-synth-wallet, x-synth-timestamp, x-synth-signature)."
      ),
    };
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

// ─── requireOwnedAgent (unchanged signature, works with both auth paths) ──────

export async function requireOwnedAgent(
  req: Request,
  agentId: string,
  options?: {
    includeFiles?: boolean;
    includeTradeLogs?: boolean;
    select?: Record<string, boolean>;
    enforceSubscription?: boolean;
  }
): Promise<{
  user: AuthenticatedUser | null;
  agent: Record<string, unknown> | null;
  error: NextResponse | null;
}> {
  const auth = await requireWalletAuth(req);
  if (auth.error || !auth.user) {
    return { user: null, agent: null, error: auth.error };
  }

  const include: Record<string, unknown> = {};
  if (options?.includeFiles) include.files = { orderBy: { createdAt: "asc" } };
  if (options?.includeTradeLogs)
    include.tradeLogs = { orderBy: { createdAt: "desc" }, take: 50 };

  const where = { id: agentId, userId: auth.user.id };
  const agent = options?.select
    ? await prisma.agent.findFirst({ where, select: options.select })
    : await prisma.agent.findFirst({ where, include });

  if (!agent) {
    return {
      user: auth.user,
      agent: null,
      error: NextResponse.json({ error: "Agent not found." }, { status: 404 }),
    };
  }

  if (options?.enforceSubscription) {
    const subscription = (await prisma.subscription.findFirst({
      where: { agentId, provider: "dodo" },
      orderBy: { updatedAt: "desc" },
      select: { status: true, validUntil: true },
    })) as SubscriptionRecord | null;

    if (subscription) {
      const isExpired = Boolean(
        subscription.validUntil && subscription.validUntil.getTime() <= Date.now()
      );
      const isActive =
        subscription.status.trim().toUpperCase() === "ACTIVE" && !isExpired;
      if (!isActive) {
        return {
          user: auth.user,
          agent: null,
          error: NextResponse.json(
            { error: "Subscription required to access this agent." },
            { status: 402 }
          ),
        };
      }
    }
  }

  return { user: auth.user, agent: agent as Record<string, unknown>, error: null };
}