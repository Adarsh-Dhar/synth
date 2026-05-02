"use client";

/**
 * frontend/app/dashboard/billing/page.tsx
 *
 * Full billing dashboard:
 *  - Current plan & usage meter
 *  - Credit top-up bundles (one-time payments)
 *  - Plan upgrade with Dodo Overlay Checkout
 *  - Manage subscription (customer portal)
 *  - Recent webhook events (subscription history)
 */

import React, { useCallback, useEffect } from "react";
import { useSearchParams } from "next/navigation";
import {
  CreditCard, Zap, RefreshCw, ExternalLink,
  CheckCircle, AlertTriangle, Info,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { useUser } from "@/lib/user-context";
import { useDodoSubscription } from "@/hooks/use-dodo-subscription";
import { PricingPlans, CreditTopups } from "@/components/pricing-plans";

// ── Tier style map ─────────────────────────────────────────────────────────────

const TIER_STYLES: Record<string, string> = {
  FREE:       "bg-slate-500/15 text-slate-300 border border-slate-500/30",
  PRO:        "bg-blue-500/15 text-blue-300 border border-blue-500/30",
  ENTERPRISE: "bg-amber-500/15 text-amber-300 border border-amber-500/30",
};

const TIER_COLORS: Record<string, string> = {
  FREE: "text-slate-300",
  PRO: "text-blue-300",
  ENTERPRISE: "text-amber-300",
};

// ── Usage meter ────────────────────────────────────────────────────────────────

function UsageMeterBar({ pct, unlimited }: { pct: number; unlimited: boolean }) {
  if (unlimited) {
    return (
      <div className="h-2 rounded-full bg-emerald-500/30">
        <div className="h-full w-full rounded-full bg-gradient-to-r from-emerald-500 to-emerald-400 animate-pulse" />
      </div>
    );
  }

  const color = pct > 90 ? "bg-red-500" : pct > 70 ? "bg-yellow-500" : "bg-primary";
  return (
    <div className="h-2 rounded-full bg-muted overflow-hidden">
      <div
        className={`h-full rounded-full transition-all duration-500 ${color}`}
        style={{ width: `${Math.min(pct, 100)}%` }}
      />
    </div>
  );
}

// ── Main page ──────────────────────────────────────────────────────────────────

export default function BillingPage() {
  const { user } = useUser();
  const searchParams = useSearchParams();
  const paymentStatus = searchParams.get("dodo");

  const {
    tier,
    limits,
    usage,
    subscription,
    agentCount,
    loading,
    error,
    refreshSubscription,
    openPortal,
  } = useDodoSubscription();

  // Refresh after a successful Dodo redirect
  useEffect(() => {
    if (paymentStatus === "success") {
      refreshSubscription();
    }
  }, [paymentStatus, refreshSubscription]);

  const handleUpgraded = useCallback(() => {
    // Give Dodo webhook a moment to fire before re-fetching
    setTimeout(refreshSubscription, 2000);
  }, [refreshSubscription]);

  if (loading) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <div className="w-8 h-8 border-2 border-primary border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  const tierLabel = tier ?? "FREE";
  const isPaid = tierLabel !== "FREE";

  return (
    <div className="min-h-screen bg-background">
      {/* ── Header ── */}
      <div className="sticky top-0 z-30 bg-background border-b border-border">
        <div className="px-6 py-4 lg:px-8 flex items-center justify-between">
          <div>
            <h1 className="text-3xl font-bold">Billing</h1>
            <p className="text-sm text-muted-foreground mt-1">
              Powered by Dodo Payments — manage subscriptions, credits, and usage
            </p>
          </div>
          <Button
            variant="ghost"
            size="sm"
            onClick={refreshSubscription}
            className="text-muted-foreground"
          >
            <RefreshCw size={16} />
          </Button>
        </div>
      </div>

      <div className="px-6 py-8 lg:px-8 max-w-5xl mx-auto space-y-8">

        {/* ── Payment status banners ── */}
        {paymentStatus === "success" && (
          <div className="p-4 rounded-lg bg-green-500/10 border border-green-500/30 flex items-center gap-3 text-green-300">
            <CheckCircle size={18} />
            <div>
              <p className="font-semibold text-sm">Payment successful!</p>
              <p className="text-xs mt-0.5">Your plan has been updated. It may take a few seconds to reflect.</p>
            </div>
          </div>
        )}
        {paymentStatus === "cancelled" && (
          <div className="p-4 rounded-lg bg-yellow-500/10 border border-yellow-500/30 flex items-center gap-3 text-yellow-300">
            <AlertTriangle size={18} />
            <p className="text-sm">Checkout was cancelled. No payment was made.</p>
          </div>
        )}
        {error && (
          <div className="p-4 rounded-lg bg-destructive/10 border border-destructive/30 text-destructive text-sm">
            {error}
          </div>
        )}

        {/* ── Current plan card ── */}
        <div className="bg-card border border-border rounded-xl p-6">
          <div className="flex items-start justify-between flex-wrap gap-4">
            <div className="flex items-center gap-4">
              <div className="w-12 h-12 rounded-xl bg-primary/10 border border-primary/20 flex items-center justify-center">
                <CreditCard size={22} className="text-primary" />
              </div>
              <div>
                <p className="text-xs text-muted-foreground">Current Plan</p>
                <div className="flex items-center gap-2 mt-0.5">
                  <h2 className={`text-2xl font-bold ${TIER_COLORS[tierLabel] ?? "text-foreground"}`}>
                    {tierLabel}
                  </h2>
                  <Badge className={TIER_STYLES[tierLabel] ?? TIER_STYLES.FREE}>
                    {tierLabel}
                  </Badge>
                </div>
                {subscription?.validUntil && (
                  <p className="text-xs text-muted-foreground mt-1">
                    Renews {new Date(subscription.validUntil).toLocaleDateString()}
                  </p>
                )}
              </div>
            </div>

            <div className="flex items-center gap-2 flex-wrap">
              {isPaid && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={openPortal}
                  className="border-border text-muted-foreground hover:text-foreground"
                >
                  <ExternalLink size={13} className="mr-1.5" />
                  Manage Subscription
                </Button>
              )}
            </div>
          </div>

          {/* Usage + limits grid */}
          <div className="mt-6 grid grid-cols-2 md:grid-cols-4 gap-4">
            {[
              { label: "Agents", value: agentCount, max: limits.maxAgents, suffix: `/ ${limits.maxAgents}` },
              { label: "Running Agents", value: "—", max: limits.maxRunning, suffix: `max ${limits.maxRunning}` },
              {
                label: "Monthly Usage",
                value: usage.unlimited ? "∞" : `${usage.units.toLocaleString()}`,
                max: usage.max,
                suffix: usage.unlimited ? "unlimited" : `/ ${usage.max.toLocaleString()}`,
              },
              { label: "Credits", value: user?.monthlyUsageUnits ?? 0, max: limits.credits || 1, suffix: limits.credits ? `/ ${limits.credits.toLocaleString()}` : "included" },
            ].map((stat) => (
              <div key={stat.label} className="bg-background rounded-lg border border-border p-4">
                <p className="text-xs text-muted-foreground">{stat.label}</p>
                <p className="text-xl font-bold text-foreground mt-1">{stat.value}</p>
                <p className="text-xs text-muted-foreground">{stat.suffix}</p>
              </div>
            ))}
          </div>

          {/* Usage bar */}
          {!usage.unlimited && (
            <div className="mt-4">
              <div className="flex justify-between text-xs text-muted-foreground mb-1">
                <span>Usage this month</span>
                <span>{usage.pct}%</span>
              </div>
              <UsageMeterBar pct={usage.pct} unlimited={false} />
              {usage.pct > 80 && (
                <p className="text-xs text-yellow-400 mt-1.5 flex items-center gap-1">
                  <Info size={11} /> You're approaching your usage limit — consider upgrading.
                </p>
              )}
            </div>
          )}

          {/* Active subscription info */}
          {subscription && (
            <div className="mt-4 pt-4 border-t border-border flex items-center gap-2 text-xs text-muted-foreground">
              <CheckCircle size={12} className="text-green-400" />
              Subscription active · ref: {subscription.externalReference.slice(0, 20)}…
            </div>
          )}
        </div>

        {/* ── Credit top-ups ── */}
        <section>
          <div className="flex items-center gap-2 mb-4">
            <Zap size={18} className="text-secondary" />
            <h2 className="text-xl font-bold">Buy Credits</h2>
            <span className="text-xs text-muted-foreground ml-1">One-time top-up · no subscription needed</span>
          </div>
          <CreditTopups onPurchased={handleUpgraded} />
        </section>

        {/* ── Plan comparison ── */}
        <section>
          <div className="mb-6">
            <h2 className="text-xl font-bold">Upgrade Your Plan</h2>
            <p className="text-sm text-muted-foreground mt-1">
              Plans include automatic monthly credits and higher concurrency limits.
            </p>
          </div>
          <PricingPlans currentTier={tierLabel} onUpgraded={handleUpgraded} />
        </section>

        {/* ── Footer note ── */}
        <p className="text-xs text-muted-foreground text-center pb-4">
          All payments are processed securely by{" "}
          <a
            href="https://dodopayments.com"
            target="_blank"
            rel="noopener noreferrer"
            className="text-primary hover:underline"
          >
            Dodo Payments
          </a>
          {" "}· Dodo acts as the Merchant of Record in 150+ countries
        </p>
      </div>
    </div>
  );
}