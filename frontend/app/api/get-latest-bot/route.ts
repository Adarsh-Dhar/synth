import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { decryptEnvConfig } from "@/lib/crypto-env";
import { requireWalletAuth } from "@/lib/auth/server";

function parseEnv(content: string): Record<string, string> {
  const parsed: Record<string, string> = {};
  for (const rawLine of content.split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const idx = line.indexOf("=");
    if (idx <= 0) continue;
    const key = line.slice(0, idx).trim();
    const value = line.slice(idx + 1).trim();
    if (key) parsed[key] = value;
  }
  return parsed;
}

function stringifyEnv(values: Record<string, string>): string {
  return Object.entries(values)
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");
}

export async function GET(req: NextRequest) {
  try {
    const auth = await requireWalletAuth(req);
    if (auth.error || !auth.user) {
      return auth.error ?? NextResponse.json({ error: "Unauthorized." }, { status: 401 });
    }

    const agentId = req.nextUrl.searchParams.get("agentId");
    const userId = auth.user.id;

    let agent;

    if (agentId) {
      agent = await prisma.agent.findFirst({
        where:   { id: agentId, userId },
        include: { files: { orderBy: { createdAt: "asc" } } },
      });
    } else {
      agent = await prisma.agent.findFirst({
        where:   { userId },
        orderBy: { createdAt: "desc" },
        include: { files: { orderBy: { createdAt: "asc" } } },
      });
    }

    if (!agent) {
      return NextResponse.json({ error: "No bot found." }, { status: 404 });
    }

    const config = agent.configuration as Record<string, unknown> | null;

    // 2. Map the standard code files
    const mappedFiles = agent.files.map(f => ({
      filepath: f.filepath,
      content:  f.content,
      language: f.language,
    }));

    // 3. Decrypt the database credentials and inject the .env file!
    if (agent.envConfig) {
      try {
        const decryptedEnv = decryptEnvConfig(agent.envConfig);
        const envMap = parseEnv(decryptedEnv);
        envMap.SESSION_KEY_MODE = "true";
        // Never send private key material to the browser.
        delete envMap.SOLANA_KEY;

        const hydratedEnv = stringifyEnv(envMap);
        mappedFiles.push({
          filepath: ".env",
          content: hydratedEnv,
          language: "plaintext"
        });
      } catch {
        console.error("Failed to decrypt envConfig for agent:", agent.id);
      }
    }

    return NextResponse.json({
      agentId:   agent.id,
      name:      agent.name,
      status:    agent.status,
      walletAddress: (agent as { walletAddress?: string }).walletAddress ?? "",
      config:    config ?? {},
      createdAt: agent.createdAt,
      files:     mappedFiles, // <-- 4. This now safely contains the .env file
    });

  } catch (err) {
    console.error("get-latest-bot Error:", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}