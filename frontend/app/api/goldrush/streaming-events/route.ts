import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireWalletAuth } from "@/lib/auth/server";

const SUPPORTED_EVENT_TYPES = ["lp_pull", "drainer_approval", "phishing_airdrop"] as const;

type SupportedEventType = (typeof SUPPORTED_EVENT_TYPES)[number];

type GoldRushEvent = {
  agentId?: string;
  type: SupportedEventType;
  txHash?: string;
  walletAddress?: string;
  tokenAddress?: string;
  chainId?: string;
  source?: string;
  riskScore?: number;
  details?: Record<string, unknown>;
  timestamp: number;
};

function parseEventFilters(url: URL): SupportedEventType[] {
  const parts = [
    ...url.searchParams.getAll("eventType"),
    ...String(url.searchParams.get("eventTypes") || "").split(","),
  ]
    .map((part) => part.trim())
    .filter((part): part is SupportedEventType =>
      SUPPORTED_EVENT_TYPES.includes(part as SupportedEventType),
    );

  return parts.length > 0 ? Array.from(new Set(parts)) : [...SUPPORTED_EVENT_TYPES];
}

function normalizeEvent(agentId: string, raw: unknown): GoldRushEvent | null {
  if (!raw || typeof raw !== "object") return null;
  const source = raw as Record<string, unknown>;
  const typeRaw = String(source.type ?? source.eventType ?? "").trim();
  if (!SUPPORTED_EVENT_TYPES.includes(typeRaw as SupportedEventType)) {
    return null;
  }

  const tsRaw = Number(source.timestamp ?? Date.now());
  const timestamp = Number.isFinite(tsRaw) ? tsRaw : Date.now();

  return {
    agentId,
    type: typeRaw as SupportedEventType,
    txHash: typeof source.txHash === "string" ? source.txHash : undefined,
    walletAddress: typeof source.walletAddress === "string" ? source.walletAddress : undefined,
    tokenAddress: typeof source.tokenAddress === "string" ? source.tokenAddress : undefined,
    chainId: typeof source.chainId === "string" ? source.chainId : undefined,
    source: typeof source.source === "string" ? source.source : "goldrush-stream",
    riskScore: typeof source.riskScore === "number" ? source.riskScore : undefined,
    details: typeof source.details === "object" && source.details ? (source.details as Record<string, unknown>) : undefined,
    timestamp,
  };
}

function toSseData(event: GoldRushEvent): string {
  return `data: ${JSON.stringify(event)}\n\n`;
}

async function requireOwnedAgentId(req: NextRequest, agentId: string): Promise<NextResponse | null> {
  const auth = await requireWalletAuth(req);
  if (auth.error || !auth.user) {
    return auth.error ?? NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  }

  const agent = await prisma.agent.findFirst({
    where: { id: agentId, userId: auth.user.id },
    select: { id: true },
  });

  if (!agent) {
    return NextResponse.json({ error: "Agent not found." }, { status: 404 });
  }

  return null;
}

function parseSseChunks(input: string): string[] {
  const chunks = input.split("\n\n");
  const events: string[] = [];
  for (const chunk of chunks) {
    if (!chunk.trim()) continue;
    const dataLines = chunk
      .split("\n")
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trim())
      .filter(Boolean);
    events.push(...dataLines);
  }
  return events;
}

export async function GET(req: NextRequest) {
  const agentId = String(req.nextUrl.searchParams.get("agentId") || "").trim();
  if (!agentId) {
    return NextResponse.json({ error: "Missing required query param: agentId" }, { status: 400 });
  }

  const ownershipError = await requireOwnedAgentId(req, agentId);
  if (ownershipError) return ownershipError;

  const filters = parseEventFilters(req.nextUrl);
  const upstream = String(process.env.GOLDRUSH_STREAM_URL || process.env.NEXT_PUBLIC_GOLDRUSH_STREAM_URL || "").trim();
  const apiKey = String(process.env.GOLDRUSH_API_KEY || "").trim();

  if (!upstream || !apiKey) {
    return NextResponse.json({ error: "GoldRush streaming is not configured." }, { status: 500 });
  }

  const upstreamUrl = new URL(upstream);
  upstreamUrl.searchParams.set("agentId", agentId);
  for (const filter of filters) {
    upstreamUrl.searchParams.append("eventType", filter);
  }

  const mode = String(req.nextUrl.searchParams.get("mode") || "sse").toLowerCase();

  if (mode === "poll") {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 2500);

    try {
      const response = await fetch(upstreamUrl.toString(), {
        method: "GET",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          Accept: "text/event-stream",
        },
        signal: controller.signal,
        cache: "no-store",
      });

      if (!response.ok || !response.body) {
        return NextResponse.json({ events: [] }, { status: 200, headers: { "Cache-Control": "no-store" } });
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let payload = "";
      const events: GoldRushEvent[] = [];
      const startedAt = Date.now();

      while (Date.now() - startedAt < 2200) {
        const { done, value } = await reader.read();
        if (done) break;
        payload += decoder.decode(value, { stream: true });

        const dataLines = parseSseChunks(payload);
        if (dataLines.length === 0) continue;

        payload = "";
        for (const line of dataLines) {
          try {
            const normalized = normalizeEvent(agentId, JSON.parse(line));
            if (normalized) events.push(normalized);
          } catch {
            // Ignore malformed event payloads.
          }
        }

        if (events.length >= 25) break;
      }

      return NextResponse.json(
        { events: events.slice(-25), filters, agentId },
        { status: 200, headers: { "Cache-Control": "no-store" } },
      );
    } catch {
      return NextResponse.json({ events: [], filters, agentId }, { status: 200, headers: { "Cache-Control": "no-store" } });
    } finally {
      clearTimeout(timer);
    }
  }

  const response = await fetch(upstreamUrl.toString(), {
    method: "GET",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      Accept: "text/event-stream",
    },
    cache: "no-store",
  });

  if (!response.ok || !response.body) {
    return NextResponse.json({ error: "Unable to connect to GoldRush stream." }, { status: 502 });
  }

  const encoder = new TextEncoder();
  const reader = response.body.getReader();
  const decoder = new TextDecoder();

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let buffer = "";
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });

          const chunks = buffer.split("\n\n");
          buffer = chunks.pop() ?? "";

          for (const chunk of chunks) {
            const lines = chunk
              .split("\n")
              .filter((line) => line.startsWith("data:"))
              .map((line) => line.slice(5).trim())
              .filter(Boolean);

            for (const line of lines) {
              try {
                const normalized = normalizeEvent(agentId, JSON.parse(line));
                if (!normalized) continue;
                controller.enqueue(encoder.encode(toSseData(normalized)));
              } catch {
                // Ignore malformed event payloads.
              }
            }
          }
        }
      } finally {
        controller.close();
        reader.releaseLock();
      }
    },
  });

  return new Response(stream, {
    status: 200,
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-store, no-cache, must-revalidate",
      Connection: "keep-alive",
    },
  });
}
