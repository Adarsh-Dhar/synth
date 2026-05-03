"use client";

/**
 * frontend/hooks/use-dodo-subscription.ts
 *
 * Fetches and refreshes the current user's Dodo subscription status.
 * Call refreshSubscription() after a successful payment to pick up the new tier.
 */

import { useCallback, useEffect, useState } from "react";
import { useUser } from "@/lib/user-context";
import { getWalletAuthHeaders } from "@/lib/auth/client";

export interface SubscriptionLimits {
  maxAgents: number;
  maxRunning: number;
  usageUnits: number;
  credits: number;
}

export interface SubscriptionUsage {
  units: number;
  max: number;
  pct: number;
  unlimited: boolean;
}

export interface ActiveSubscription {
  id: string;
  status: string;
  plan: string | null;
  validUntil: string | null;
  externalReference: string;
  createdAt: string;
  updatedAt: string;
}

export interface DodoSubscriptionState {
  tier: string;
  limits: SubscriptionLimits;
  usage: SubscriptionUsage;
  subscription: ActiveSubscription | null;
  agentCount: number;
  loading: boolean;
  error: string | null;
}

const INITIAL_STATE: DodoSubscriptionState = {
  tier: "FREE",
  limits: { maxAgents: 2, maxRunning: 1, usageUnits: 500, credits: 0 },
  usage: { units: 0, max: 500, pct: 0, unlimited: false },
  subscription: null,
  agentCount: 0,
  loading: true,
  error: null,
};

export function useDodoSubscription() {
  const { walletSigner } = useUser();
  const [state, setState] = useState<DodoSubscriptionState>(INITIAL_STATE);

  const fetchStatus = useCallback(async () => {
    setState((prev) => ({ ...prev, loading: true, error: null }));
    try {
      const authHeaders = await getWalletAuthHeaders(walletSigner);
      const res = await fetch("/api/payments/status", {
        headers: { ...(authHeaders ?? {}) },
        cache: "no-store",
      });

      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error((body as { error?: string }).error ?? `HTTP ${res.status}`);
      }

      const data = (await res.json().catch(() => ({}))) as Partial<DodoSubscriptionState>;
      const safeLimits = {
        maxAgents: Number(data.limits?.maxAgents ?? INITIAL_STATE.limits.maxAgents),
        maxRunning: Number(data.limits?.maxRunning ?? INITIAL_STATE.limits.maxRunning),
        usageUnits: Number(data.limits?.usageUnits ?? INITIAL_STATE.limits.usageUnits),
        credits: Number(data.limits?.credits ?? INITIAL_STATE.limits.credits),
      };

      const usageMax = Number(data.usage?.max ?? safeLimits.usageUnits);
      const usageUnits = Number(data.usage?.units ?? 0);
      const safeUsage = {
        units: Number.isFinite(usageUnits) ? usageUnits : 0,
        max: Number.isFinite(usageMax) ? usageMax : safeLimits.usageUnits,
        pct: Number.isFinite(Number(data.usage?.pct)) ? Number(data.usage?.pct) : 0,
        unlimited: Boolean(data.usage?.unlimited),
      };

      setState({
        tier: String(data.tier ?? INITIAL_STATE.tier),
        limits: safeLimits,
        usage: safeUsage,
        subscription: data.subscription ?? null,
        agentCount: Number(data.agentCount ?? 0),
        loading: false,
        error: null,
      });
    } catch (err) {
      setState((prev) => ({
        ...prev,
        loading: false,
        error: err instanceof Error ? err.message : "Failed to load subscription",
      }));
    }
  }, [walletSigner]);

  // Load on mount
  useEffect(() => {
    fetchStatus();
  }, [fetchStatus]);

  // Open Dodo customer portal
  const openPortal = useCallback(async () => {
    try {
      const authHeaders = await getWalletAuthHeaders(walletSigner);
      const res = await fetch("/api/payments/customer-portal", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(authHeaders ?? {}) },
      });
      const data = (await res.json()) as { portalUrl?: string };
      if (data.portalUrl) {
        window.open(data.portalUrl, "_blank", "noopener,noreferrer");
      }
    } catch (err) {
      console.error("[useDodoSubscription] openPortal error:", err);
    }
  }, [walletSigner]);

  return {
    ...state,
    refreshSubscription: fetchStatus,
    openPortal,
  };
}