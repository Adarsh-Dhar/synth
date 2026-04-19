import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

// ─── POST /api/users/sync ─────────────────────────────────────────────────────
// Upserts a user record by email (Clerk user ID is the primary key).
// Called after Clerk authentication to ensure the user exists in our DB.
export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { walletAddress } = body;

    // Wallet-based user sync
    if (walletAddress && typeof walletAddress === "string" && walletAddress.trim()) {
      const normalizedWallet = walletAddress.trim();

      const existing = await prisma.user.findFirst({
        where: { walletAddress: normalizedWallet },
      });

      if (existing) {
        return NextResponse.json(existing, { status: 200 });
      }

      const walletId = `wallet:${normalizedWallet}`;
      const emailSafe = normalizedWallet.replace(/[^a-zA-Z0-9._-]/g, "_");

      const user = await prisma.user.create({
        data: {
          id: walletId,
          email: `${emailSafe}@wallet.local`,
          walletAddress: normalizedWallet,
        },
      });
      return NextResponse.json(user, { status: 200 });
    }

    // Fallback: require id/email for Clerk-authenticated users (legacy)
    const { id, email, name } = body;
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
      create: { id, email, ...(name ? { name } : {}) },
    });
    return NextResponse.json(user, { status: 200 });
  } catch (error: unknown) {
    // Unique constraint on email — another account already uses it
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