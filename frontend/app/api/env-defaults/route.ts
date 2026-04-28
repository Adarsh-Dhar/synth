import { NextResponse } from "next/server";
import fs from "node:fs";
import path from "node:path";

const DISCOVERY_KEYS = [
  "MCP_GATEWAY_URL",
  "RPC_PROVIDER_URL",
  "SOLANA_RPC_URL",
  "SOLANA_NETWORK",
  "JUPITER_DOCS_MCP_URL",
  "DODO_DOCS_MCP_URL",
  "DODO_PLAN_PRO_ID",
  "DODO_WEBHOOK_SECRET",
  "GOLDRUSH_API_KEY",
  "GOLDRUSH_STREAM_URL",
  "GOLDRUSH_MCP_URL",
  "MAGICBLOCK_PRIVATE_PAYMENTS_BASE_URL",
  "UMBRA_PROGRAM_ADDRESS",
] as const;

function parseEnvText(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  const lines = text.split(/\r?\n/);

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;

    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    const hash = value.indexOf(" #");
    if (hash >= 0) value = value.slice(0, hash).trim();

    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    if (key) out[key] = value;
  }

  return out;
}

export async function GET() {
  try {
    const loaded: Record<string, string> = {};
    const candidates = [
      path.resolve(process.cwd(), "../agents/.env"),
      path.resolve(process.cwd(), "../agents/.env.local"),
    ];

    for (const file of candidates) {
      try {
        if (!fs.existsSync(file)) continue;
        const envText = fs.readFileSync(file, "utf8");
        Object.assign(loaded, parseEnvText(envText));
      } catch {
        // ignore unreadable files
      }
    }

    const values: Record<string, string> = {};
    for (const key of DISCOVERY_KEYS) {
      const fromLoaded = String(loaded[key] ?? "").trim();
      const fromProc = String(process.env[key] ?? "").trim();
      const value = fromLoaded || fromProc;
      if (value) values[key] = value;
    }

    const mcpCandidates = [
      loaded["MCP_GATEWAY_URL"],
      values["MCP_GATEWAY_URL"],
      process.env["MCP_GATEWAY_URL"],
      process.env["NEXT_PUBLIC_MCP_GATEWAY_URL"],
    ].map((v) => String(v ?? "").trim()).filter(Boolean);

    const isLocal = (url: string): boolean => {
      const normalized = String(url || "").trim().toLowerCase();
      return (
        normalized.includes("localhost") ||
        normalized.includes("127.0.0.1") ||
        normalized.includes("0.0.0.0") ||
        normalized.includes("192.168.")
      );
    };

    const publicMcp = mcpCandidates.find((url) => !isLocal(url));
    if (publicMcp) values["MCP_GATEWAY_URL"] = publicMcp;
    
    // Ensure RPC provider URL aliases are present for discovery (prefer Solana then Solana)
    if (!values["RPC_PROVIDER_URL"] && values["SOLANA_RPC_URL"]) {
      values["RPC_PROVIDER_URL"] = values["SOLANA_RPC_URL"];
    }
    if (!values["SOLANA_RPC_URL"] && values["RPC_PROVIDER_URL"]) {
      values["SOLANA_RPC_URL"] = values["RPC_PROVIDER_URL"];
    }

    // Backwards compatibility: fall back to SOLANA_RPC_URL if SOLANA not present
    if (!values["RPC_PROVIDER_URL"] && values["SOLANA_RPC_URL"]) {
      values["RPC_PROVIDER_URL"] = values["SOLANA_RPC_URL"];
    }
    if (!values["SOLANA_RPC_URL"] && values["RPC_PROVIDER_URL"]) {
      values["SOLANA_RPC_URL"] = values["RPC_PROVIDER_URL"];
    }
    
    return NextResponse.json({ values });
  } catch {
    return NextResponse.json({ values: {} });
  }
}
