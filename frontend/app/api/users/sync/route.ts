import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

// ─── POST /api/users/sync ─────────────────────────────────────────────────────
// Upserts a user record by email (Clerk user ID is the primary key).
// Called after Clerk authentication to ensure the user exists in our DB.
export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { walletAddress } = body;

    // If walletAddress is provided, use public-user logic
    if (walletAddress && typeof walletAddress === "string" && walletAddress.trim()) {
      const user = await prisma.user.upsert({
        where: { id: "public-user" },
        update: { walletAddress },
        create: {
          id: "public-user",
          email: "public-user@placeholder.agentia",
          walletAddress,
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