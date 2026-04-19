"use client";

import { useEffect, useMemo, useState } from "react";

export type GoldRushThreatType = "lp_pull" | "drainer_approval" | "phishing_airdrop";

export type GoldRushStreamEvent = {
  agentId?: string;
  type: GoldRushThreatType;
  txHash?: string;
  walletAddress?: string;
  tokenAddress?: string;
  chainId?: string;
  source?: string;
  riskScore?: number;
  details?: Record<string, unknown>;
  mint?: string;
  usdValue?: number;
  timestamp: number;
};

const DEFAULT_FILTERS: GoldRushThreatType[] = ["lp_pull", "drainer_approval", "phishing_airdrop"];

function normalizeEvent(raw: Partial<GoldRushStreamEvent>): GoldRushStreamEvent | null {
  if (!raw || typeof raw !== "object") return null;
  if (!raw.type || !DEFAULT_FILTERS.includes(raw.type)) return null;
  return {
    agentId: raw.agentId,
    type: raw.type,
    txHash: raw.txHash,
    walletAddress: raw.walletAddress,
    tokenAddress: raw.tokenAddress,
    chainId: raw.chainId,
    source: raw.source,
    riskScore: raw.riskScore,
    details: raw.details,
    mint: raw.mint,
    usdValue: raw.usdValue,
    timestamp: raw.timestamp ?? Date.now(),
  };
}

function pushEvent(prev: GoldRushStreamEvent[], next: GoldRushStreamEvent): GoldRushStreamEvent[] {
  return [...prev.slice(-99), next];
}

export function useGoldRushStream(
  agentId: string,
  filters: GoldRushThreatType[] = DEFAULT_FILTERS,
) {
  const [events, setEvents] = useState<GoldRushStreamEvent[]>([]);
  const [connected, setConnected] = useState(false);

  const streamUrl = useMemo(() => {
    const url = new URL("/api/goldrush/streaming-events", window.location.origin);
    url.searchParams.set("agentId", agentId);
    for (const filter of filters) {
      url.searchParams.append("eventType", filter);
    }
    return url.toString();
  }, [agentId, filters]);

  useEffect(() => {
    if (!agentId) return;

    let eventSource: EventSource | null = null;
    let pollInterval: ReturnType<typeof setInterval> | null = null;
    let alive = true;

    const startPollingFallback = () => {
      if (pollInterval) return;
      pollInterval = setInterval(async () => {
        if (!alive) return;
        try {
          const pollUrl = new URL(streamUrl);
          pollUrl.searchParams.set("mode", "poll");
          const response = await fetch(pollUrl.toString(), { cache: "no-store" });
          if (!response.ok) return;
          const payload = (await response.json()) as { events?: Partial<GoldRushStreamEvent>[] };
          const batch = Array.isArray(payload.events) ? payload.events : [];
          if (batch.length === 0) return;

          setEvents((prev) => {
            let next = prev;
            for (const event of batch) {
              const normalized = normalizeEvent(event);
              if (!normalized) continue;
              next = pushEvent(next, normalized);
            }
            return next;
          });
        } catch {
          // Ignore polling failures and retry.
        }
      }, 5000);
    };

    try {
      eventSource = new EventSource(streamUrl);
      eventSource.onopen = () => {
        if (!alive) return;
        setConnected(true);
      };
      eventSource.onerror = () => {
        if (!alive) return;
        setConnected(false);
        startPollingFallback();
      };
      eventSource.onmessage = (message) => {
        if (!alive) return;
        try {
          const normalized = normalizeEvent(JSON.parse(message.data || "{}") as Partial<GoldRushStreamEvent>);
          if (!normalized) return;
          setEvents((prev) => pushEvent(prev, normalized));
        } catch {
          // Ignore malformed stream payloads.
        }
      };
    } catch {
      setConnected(false);
      startPollingFallback();
    }

    return () => {
      alive = false;
      eventSource?.close();
      if (pollInterval) clearInterval(pollInterval);
    };
  }, [agentId, streamUrl]);

  return { events, connected };
}
