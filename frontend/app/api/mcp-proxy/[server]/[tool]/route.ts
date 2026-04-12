import { NextRequest, NextResponse } from "next/server";

function normalizeGatewayBase(raw: string): string {
  return String(raw || "").trim().replace(/\/+$/, "");
}

function buildUpstreamCandidates(gateway: string, server: string, tool: string): string[] {
  const base = normalizeGatewayBase(gateway);
  if (!base) return [];

  const withMcp = /\/mcp$/i.test(base) ? base : `${base}/mcp`;
  const withoutMcp = base.replace(/\/mcp$/i, "");

  const candidates = [
    `${withMcp}/${server}/${tool}`,
    `${withoutMcp}/${server}/${tool}`,
  ];

  return Array.from(new Set(candidates));
}

export async function POST(
  req: NextRequest,
  ctx: { params: Promise<{ server: string; tool: string }> },
) {
  const { server, tool } = await ctx.params;
  const sessionKeyHeader = String(req.headers.get("x-session-key") || "").trim();
  const gateway = normalizeGatewayBase(
    req.headers.get("x-mcp-upstream-url") ||
    process.env.MCP_GATEWAY_URL ||
    process.env.NEXT_PUBLIC_MCP_GATEWAY_URL ||
    "",
  );

  if (!gateway) {
    return NextResponse.json(
      {
        error: "MCP gateway not configured",
        hint: "Set MCP_GATEWAY_URL in frontend server environment.",
      },
      { status: 500 },
    );
  }

  const upstreamCandidates = buildUpstreamCandidates(gateway, server, tool);

  let payload: unknown;
  try {
    payload = await req.json();
  } catch {
    payload = {};
  }

  try {
    let lastBodyText = "";
    let lastStatus = 502;
    let lastContentType = "application/json";
    let lastUrl = upstreamCandidates[0] || "";

    for (const upstreamUrl of upstreamCandidates) {
      lastUrl = upstreamUrl;
      const upstream = await fetch(upstreamUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "ngrok-skip-browser-warning": "true",
          "Bypass-Tunnel-Reminder": "true",
          ...(sessionKeyHeader ? { "x-session-key": sessionKeyHeader } : {}),
        },
        body: JSON.stringify(payload),
        cache: "no-store",
      });

      lastStatus = upstream.status;
      lastContentType = upstream.headers.get("content-type") || "application/json";
      lastBodyText = await upstream.text();

      // Retry on obvious path mismatch. Return immediately for all other statuses.
      if (upstream.status !== 404) {
        return new NextResponse(lastBodyText, {
          status: lastStatus,
          headers: {
            "Content-Type": lastContentType,
            "Cache-Control": "no-store",
          },
        });
      }
    }

    return new NextResponse(lastBodyText, {
      status: lastStatus,
      headers: {
        "Content-Type": lastContentType,
        "Cache-Control": "no-store",
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json(
      {
        error: "Upstream MCP request failed",
        upstreamUrl: upstreamCandidates[0] || "",
        details: message,
      },
      { status: 502 },
    );
  }
}
