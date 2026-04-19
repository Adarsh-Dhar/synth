"use client";

import React, { useEffect, useState } from "react";
import { Wallet } from "lucide-react";
import { useWallet } from "@solana/wallet-adapter-react";
import { useUser } from "@/lib/user-context";
import { getWalletAuthHeaders } from "@/lib/auth/client";

type PortfolioItem = {
  contract_ticker_symbol?: string;
  quote?: number;
};

type PortfolioResponse = {
  portfolio?: {
    data?: {
      items?: PortfolioItem[];
    };
  };
};

export function PortfolioPanel() {
  const { publicKey } = useWallet();
  const { walletSigner } = useUser();
  const [totalUsd, setTotalUsd] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const wallet = publicKey?.toBase58();
    if (!wallet) return;

    let mounted = true;

    const load = async () => {
      try {
        if (!mounted) return;
        setLoading(true);
        const authHeaders = await getWalletAuthHeaders(walletSigner);
        const res = await fetch(`/api/goldrush/portfolio?wallet=${encodeURIComponent(wallet)}`, {
          headers: {
            ...(authHeaders ?? {}),
          },
        });

        const json = (await res.json()) as PortfolioResponse & { error?: string };
        if (!res.ok) {
          throw new Error(json.error || "Failed to load portfolio.");
        }

        const items = json.portfolio?.data?.items || [];
        const sum = items.reduce((acc, it) => {
          const value = typeof it.quote === "number" ? it.quote : 0;
          return acc + (Number.isFinite(value) ? value : 0);
        }, 0);

        if (mounted) {
          setTotalUsd(sum);
          setError(null);
        }
      } catch (err) {
        if (mounted) setError(err instanceof Error ? err.message : String(err));
      } finally {
        if (mounted) setLoading(false);
      }
    };

    load();
  }, [publicKey, walletSigner]);

  return (
    <div className="bg-card border border-border rounded-lg p-6">
      <div className="flex items-center justify-between mb-2">
        <h3 className="text-sm font-semibold text-foreground">GoldRush Portfolio</h3>
        <Wallet size={16} className="text-muted-foreground" />
      </div>
      <p className="text-xs text-muted-foreground mb-3">Live wallet valuation from decoded on-chain balances.</p>
      {loading ? (
        <p className="text-sm text-muted-foreground">Loading portfolio...</p>
      ) : error ? (
        <p className="text-sm text-red-400">{error}</p>
      ) : (
        <div>
          <p className="text-2xl font-bold text-foreground">${totalUsd.toFixed(2)}</p>
          <p className="text-xs text-muted-foreground mt-1">Approximate USD mark-to-market</p>
        </div>
      )}
    </div>
  );
}
