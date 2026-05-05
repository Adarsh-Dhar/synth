import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

/**
 * POST /api/users/sync
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

      const emailSafe = normalizedWallet.replace(/[^a-zA-Z0-9._-]/g, "_");

      // For Privy synthetic IDs, the canonical DB id is "privy:<userId>".
      // For real wallet addresses, we let Prisma generate a cuid — the wallet
      // is stored in walletAddress only, NOT baked into the id field.
      if (isPrivySynthetic) {
        const syntheticId = normalizedWallet; // "privy:<userId>"

        const byId = await prisma.user.findFirst({ where: { id: syntheticId } });
        if (byId) return NextResponse.json(byId, { status: 200 });

        const byWallet = await prisma.user.findFirst({ where: { walletAddress: normalizedWallet } });
        if (byWallet) return NextResponse.json(byWallet, { status: 200 });

        const user = await prisma.user.create({
          data: {
            id: syntheticId,
            email: `${emailSafe}@privy.local`,
            walletAddress: normalizedWallet,
            plan: "free",
            planStartedAt: new Date(),
          },
        });
        return NextResponse.json(user, { status: 200 });
      }

      // Real Solana wallet — find or create, never set id manually
      const existing = await prisma.user.findFirst({
        where: { walletAddress: normalizedWallet },
      });
      if (existing) return NextResponse.json(existing, { status: 200 });

      // Create with auto-generated cuid (no `id` field supplied)
      const user = await prisma.user.create({
        data: {
          email: `${emailSafe}@wallet.local`,
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
        { error: "id (Clerk user ID) is required if walletAddress is not provided." },
        { status: 400 }
      );
    }
    if (!email || typeof email !== "string" || !email.trim()) {
      return NextResponse.json(
        { error: "email is required if walletAddress is not provided." },
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
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      (error as { code: string }).code === "P2002"
    ) {
      return NextResponse.json(
        { error: "This email address is already associated with another account." },
        { status: 409 }
      );
    }
    console.error("[/api/users/sync] Error:", error);
    return NextResponse.json({ error: "Internal server error." }, { status: 500 });
  }
}