import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

/**
 * POST /api/users/sync  (updated)
 *
 * Upserts a user record by walletAddress OR Privy synthetic ID.
 *
 * Accepts:
 *   { walletAddress: string }           — Solana wallet (base58) or "privy:<userId>"
 *   { id: string, email: string }       — Legacy Clerk flow (kept for back-compat)
 */
export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { walletAddress } = body as { walletAddress?: string };

    // ── Wallet / Privy synthetic address ─────────────────────────────────────
    if (walletAddress && typeof walletAddress === "string" && walletAddress.trim()) {
      const normalizedWallet = walletAddress.trim();
      const isPrivySynthetic = normalizedWallet.startsWith("privy:");

      // Determine the canonical user ID
      const userId = isPrivySynthetic
        ? normalizedWallet          // "privy:<userId>"
        : `wallet:${normalizedWallet}`;

      const emailSafe = normalizedWallet.replace(/[^a-zA-Z0-9._-]/g, "_");

      // Try to find by wallet address first
      const byWallet = await prisma.user.findFirst({
        where: { walletAddress: normalizedWallet },
      });
      if (byWallet) return NextResponse.json(byWallet, { status: 200 });

      // Try to find by ID (in case already created by server auth)
      const byId = await prisma.user.findFirst({ where: { id: userId } });
      if (byId) return NextResponse.json(byId, { status: 200 });

      // Create new user
      const user = await prisma.user.create({
        data: {
          id: userId,
          email: isPrivySynthetic
            ? `${emailSafe}@privy.local`
            : `${emailSafe}@wallet.local`,
          walletAddress: normalizedWallet,
          plan: "free",
          planStartedAt: new Date(),
        },
      });
      return NextResponse.json(user, { status: 200 });
    }

    // ── Legacy Clerk flow ─────────────────────────────────────────────────────
    const { id, email, name } = body as {
      id?: string;
      email?: string;
      name?: string;
    };

    if (!id || typeof id !== "string" || !id.trim()) {
      return NextResponse.json(
        {
          error:
            "id (Clerk user ID) is required if walletAddress is not provided.",
        },
        { status: 400 }
      );
    }
    if (!email || typeof email !== "string" || !email.trim()) {
      return NextResponse.json(
        {
          error:
            "email is required if walletAddress is not provided.",
        },
        { status: 400 }
      );
    }

    const user = await prisma.user.upsert({
      where: { id },
      update: { email, ...(name ? { name } : {}) },
      create: { id, email, ...(name ? { name } : {}), plan: "free", planStartedAt: new Date() },
    });
    return NextResponse.json(user, { status: 200 });
  } catch (error: unknown) {
    // Unique constraint on email
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      (error as { code: string }).code === "P2002"
    ) {
      return NextResponse.json(
        {
          error:
            "This email address is already associated with another account.",
        },
        { status: 409 }
      );
    }
    console.error("[/api/users/sync] Error:", error);
    return NextResponse.json({ error: "Internal server error." }, { status: 500 });
  }
}