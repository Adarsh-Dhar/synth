"use client";

import { useEffect, useMemo, useState } from "react";

type GoldRushStreamEvent = {
  txHash?: string;
  mint?: string;
  usdValue?: number;
  timestamp: number;
};

export function useGoldRushStream(agentId: string) {
  const [events, setEvents] = useState<GoldRushStreamEvent[]>([]);
  const [connected, setConnected] = useState(false);

  const streamUrl = useMemo(() => {
    const base = process.env.NEXT_PUBLIC_GOLDRUSH_STREAM_URL || "";
    if (!base) return null;
    try {
      const url = new URL(base);
      url.searchParams.set("agentId", agentId);
      return url.toString();
    } catch {
      return null;
    }
  }, [agentId]);

  useEffect(() => {
    if (!streamUrl) return;

    let ws: WebSocket | null = null;
    let alive = true;

    try {
      ws = new WebSocket(streamUrl);
      ws.onopen = () => {
        if (alive) setConnected(true);
      };
      ws.onclose = () => {
        if (alive) setConnected(false);
      };
      ws.onerror = () => {
        if (alive) setConnected(false);
      };
      ws.onmessage = (event) => {
        if (!alive) return;
        try {
          const raw = JSON.parse(String(event.data || "{}")) as Partial<GoldRushStreamEvent>;
          const normalized: GoldRushStreamEvent = {
            txHash: raw.txHash,
            mint: raw.mint,
            usdValue: raw.usdValue,
            timestamp: raw.timestamp ?? Date.now(),
          };
          setEvents((prev) => [...prev.slice(-99), normalized]);
        } catch {
          // Ignore malformed stream payloads.
        }
      };
    } catch {
      setConnected(false);
    }

    return () => {
      alive = false;
      ws?.close();
    };
  }, [streamUrl]);

  return { events, connected };
}
