"use client";

import { useEffect, useMemo, useState } from "react";
import { getWalletAuthHeaders, type WalletSigner } from "@/lib/auth/client";

type PriceState = {
  pricesUsd: Record<string, number>;
  loading: boolean;
  error: string | null;
};

export function useTokenPrices(mints: string[], walletSigner: WalletSigner, pollMs = 15000): PriceState {
  const [pricesUsd, setPricesUsd] = useState<Record<string, number>>({});
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const key = useMemo(() => mints.filter(Boolean).join(","), [mints]);

  useEffect(() => {
    if (!key) return;
    let mounted = true;

    const load = async () => {
      try {
        if (!mounted) return;
        setLoading(true);
        const authHeaders = await getWalletAuthHeaders(walletSigner);
        const res = await fetch(`/api/goldrush/token-prices?mints=${encodeURIComponent(key)}`, {
          headers: {
            ...(authHeaders ?? {}),
          },
        });
        const json = (await res.json()) as { pricesUsd?: Record<string, number>; error?: string };
        if (!res.ok) {
          throw new Error(json.error || "Failed to fetch token prices.");
        }
        if (mounted) {
          setPricesUsd(json.pricesUsd || {});
          setError(null);
        }
      } catch (err) {
        if (mounted) setError(err instanceof Error ? err.message : String(err));
      } finally {
        if (mounted) setLoading(false);
      }
    };

    load();
    const timer = window.setInterval(load, pollMs);
    return () => {
      mounted = false;
      window.clearInterval(timer);
    };
  }, [key, pollMs, walletSigner]);

  return { pricesUsd, loading, error };
}
