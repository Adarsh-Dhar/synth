/**
 * frontend/app/api/get-bot-code/route.ts
 *
 * Serves generated bot files (Solana by default) so backend workers can install deps and run them.
 *
 * All file content is inlined here so the route works without filesystem
 * access to the /agents directory in production.
 */

import { NextResponse } from "next/server";
import { assembleBotFiles } from "./bot-files";
import { prisma } from "@/lib/prisma";
import { encryptEnvConfig } from "@/lib/crypto-env";
import { requireWalletAuth } from "@/lib/auth/server";

export async function POST(req: Request) {
  const auth = await requireWalletAuth(req);
  if (auth.error || !auth.user) {
    return auth.error ?? NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  }

  // If called with a body, use envConfig/configuration from the request, else just save files
  let envConfig = undefined;
  let configuration = undefined;
  let name = "Solana Bot";
  if (req && typeof req.json === "function") {
    try {
      const body = await req.json();
      if (body) {
        envConfig = body.envConfig;
        configuration = body.configuration;
        if (body.name) name = body.name;
      }
    } catch {
      // Request body is optional for this endpoint.
    }
  }

  const files = assembleBotFiles();
  console.log(`[POST /api/get-bot-code]`, files);

  // Save to DB (same as save-bot logic)
  try {
    const userId = auth.user.id;

    if (!files || !Array.isArray(files) || files.length === 0) {
      return NextResponse.json({ error: "No files provided." }, { status: 400 });
    }

    for (const f of files) {
      if (!f.filepath || typeof f.filepath !== "string") {
        return NextResponse.json(
          { error: "Each file must have a filepath string." },
          { status: 400 }
        );
      }
      if (typeof f.content !== "string") {
        return NextResponse.json(
          { error: `File "${f.filepath}" is missing content.` },
          { status: 400 }
        );
      }
    }

    // Build the configuration object stored in the DB.
    // envConfig is encrypted; nothing sensitive lands in plaintext.
    const mergedConfiguration = { ...(configuration ?? {}) };

    if (envConfig && typeof envConfig === "object") {
      // Strip empty values so we don't encrypt "" for optional fields
      const sanitized: Record<string, string> = {};
      for (const [k, v] of Object.entries(envConfig)) {
        if (typeof v === "string" && v.trim().length > 0) {
          sanitized[k] = v.trim();
        }
      }
      if (Object.keys(sanitized).length > 0) {
        mergedConfiguration.encryptedEnv = encryptEnvConfig(JSON.stringify(sanitized));
      }
    }

    const agent = await prisma.agent.create({
      data: {
        name,
        userId,
        status: "STOPPED",
        configuration: mergedConfiguration,
        files: {
          create: files.map(
            (f) => ({
              filepath: f.filepath,
              content: f.content,
              language: f.filepath?.split(".").pop() ?? "plaintext",
            })
          ),
        },
      },
      include: { files: true },
    });

    return NextResponse.json({
      thoughts:
        "Bot generated successfully. Configure RPC and keys, then run in simulation or live mode.",
      files,
      verified: true,
      agentId: agent.id,
      agent,
      saved: true,
    });
  } catch (error) {
    const err = error instanceof Error ? error.message : String(error);
    console.error("[POST /api/get-bot-code] Error:", err);
    return NextResponse.json(
      { error: err || null },
      { status: 500 }
    );
  }
}