"use client";

/**
 * frontend/components/pricing-plans.tsx
 *
 * Renders the three subscription tiers with feature lists and Dodo checkout buttons.
 * Import on /dashboard/pricing or embed in the billing page.
 */

import { Check, Zap } from "lucide-react";
import { DodoCheckoutButton } from "@/components/dodo-checkout-button";

interface Plan {
  id: "free" | "pro" | "enterprise";
  name: string;
  price: string;
  period: string;
  description: string;
  features: string[];
  limits: {
    agents: number | string;
    runningAgents: number | string;
    usageUnits: number | string;
    credits?: number | string;
  };
  highlight?: boolean;
  ctaLabel: string;
  productId?: string;
}

const PLANS: Plan[] = [
  {
    id: "free",
    name: "Free",
    price: "$0",
    period: "forever",
    description: "Get started with Solana bot automation.",
    features: [
      "2 agents",
      "1 running agent at a time",
      "500 usage units / month",
      "Spread scanner & yield sweeper",
      "Community support",
    ],
    limits: { agents: 2, runningAgents: 1, usageUnits: 500 },
    ctaLabel: "Current plan",
  },
  {
    id: "pro",
    name: "Pro",
    price: "$14.99",
    period: "/ month",
    description: "Serious traders running multiple concurrent bots.",
    features: [
      "10 agents",
      "5 running agents at a time",
      "10,000 usage units / month",
      "2,000 credits included monthly",
      "All bot strategies",
      "GoldRush portfolio analytics",
      "Priority support",
    ],
    limits: { agents: 10, runningAgents: 5, usageUnits: 10_000, credits: 2_000 },
    highlight: true,
    ctaLabel: "Upgrade to Pro",
    productId: "pdt_0Ne0ZzHuknqvRLcRxK1K9",
  },
  {
    id: "enterprise",
    name: "Enterprise",
    price: "$99.99",
    period: "/ month",
    description: "Teams and institutional traders at scale.",
    features: [
      "100 agents",
      "25 running agents at a time",
      "Unlimited usage units",
      "10,000 credits included monthly",
      "All Pro features",
      "Private execution (MagicBlock + Umbra)",
      "Custom webhook endpoints",
      "Dedicated support",
    ],
    limits: { agents: 100, runningAgents: 25, usageUnits: "Unlimited", credits: 10_000 },
    ctaLabel: "Upgrade to Enterprise",
    productId: "pdt_0Ne0aCoFw2FGrzxaPrPiN",
  },
];

interface PricingPlansProps {
  currentTier?: string;
  onUpgraded?: () => void;
  compact?: boolean;
}

export function PricingPlans({ currentTier = "FREE", onUpgraded, compact = false }: PricingPlansProps) {
  const activeTier = currentTier.toUpperCase();

  return (
    <div className={`grid gap-6 ${compact ? "grid-cols-1 md:grid-cols-3" : "grid-cols-1 md:grid-cols-3"}`}>
      {PLANS.map((plan) => {
        const isCurrent = activeTier === plan.id.toUpperCase();
        const isDowngrade =
          (activeTier === "PRO" && plan.id === "free") ||
          (activeTier === "ENTERPRISE" && (plan.id === "free" || plan.id === "pro"));

        return (
          <div
            key={plan.id}
            className={`relative rounded-xl border p-6 flex flex-col gap-4 transition-all ${
              plan.highlight
                ? "border-primary/60 bg-primary/5 shadow-lg shadow-primary/10"
                : "border-border bg-card"
            } ${isCurrent ? "ring-2 ring-primary/40" : ""}`}
          >
            {plan.highlight && (
              <div className="absolute -top-3 left-1/2 -translate-x-1/2">
                <span className="bg-primary text-primary-foreground text-xs font-bold px-3 py-1 rounded-full">
                  Most Popular
                </span>
              </div>
            )}

            {isCurrent && (
              <div className="absolute -top-3 right-4">
                <span className="bg-secondary text-secondary-foreground text-xs font-bold px-3 py-1 rounded-full">
                  Current plan
                </span>
              </div>
            )}

            {/* Header */}
            <div>
              <h3 className="text-lg font-bold text-foreground">{plan.name}</h3>
              <p className="text-sm text-muted-foreground mt-1">{plan.description}</p>
            </div>

            {/* Price */}
            <div className="flex items-end gap-1">
              <span className="text-4xl font-bold text-foreground">{plan.price}</span>
              <span className="text-sm text-muted-foreground pb-1">{plan.period}</span>
            </div>

            {/* Features */}
            <ul className="flex-1 space-y-2">
              {plan.features.map((feature) => (
                <li key={feature} className="flex items-start gap-2 text-sm text-foreground/80">
                  <Check size={14} className="text-primary flex-shrink-0 mt-0.5" />
                  {feature}
                </li>
              ))}
            </ul>

            {/* CTA */}
            <div className="mt-2">
              {isCurrent ? (
                <div className="w-full py-2 px-4 text-center text-sm font-medium text-muted-foreground border border-border rounded-lg">
                  ✓ Your current plan
                </div>
              ) : isDowngrade ? (
                <div className="w-full py-2 px-4 text-center text-xs text-muted-foreground/60 border border-border/40 rounded-lg">
                  Manage via customer portal
                </div>
              ) : plan.id === "free" ? (
                <div className="w-full py-2 px-4 text-center text-sm text-muted-foreground border border-border rounded-lg">
                  No payment required
                </div>
              ) : (
                <DodoCheckoutButton
                  planType={plan.id as "pro" | "enterprise"}
                  productId={plan.productId}
                  label={plan.ctaLabel}
                  className={`w-full ${plan.highlight ? "bg-primary hover:bg-primary/90 text-primary-foreground" : ""}`}
                  variant={plan.highlight ? "default" : "outline"}
                  onSuccess={onUpgraded}
                />
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ── Credit top-up bundles ─────────────────────────────────────────────────────

interface TopupBundle {
  id: string;
  credits: number;
  price: string;
  priceLabel: string;
  productId: string;
  popular?: boolean;
}

const TOPUP_BUNDLES: TopupBundle[] = [
  {
    id: "500",
    credits: 500,
    price: "$4.99",
    priceLabel: "$0.00998 / credit",
    productId: "pdt_0Ne0aafxIPJ1U3L2TuQ1l",
  },
  {
    id: "2000",
    credits: 2_000,
    price: "$14.99",
    priceLabel: "$0.0075 / credit",
    productId: "pdt_0Ne0ajLByYILVD88OEGSz",
    popular: true,
  },
  {
    id: "10000",
    credits: 10_000,
    price: "$49.99",
    priceLabel: "$0.005 / credit",
    productId: "pdt_0Ne0ariRdRBGFskEOFvXd",
  },
];

interface CreditTopupsProps {
  onPurchased?: () => void;
}

export function CreditTopups({ onPurchased }: CreditTopupsProps) {
  return (
    <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
      {TOPUP_BUNDLES.map((bundle) => (
        <div
          key={bundle.id}
          className={`relative rounded-xl border p-5 flex flex-col gap-3 ${
            bundle.popular ? "border-secondary/60 bg-secondary/5" : "border-border bg-card"
          }`}
        >
          {bundle.popular && (
            <div className="absolute -top-3 left-1/2 -translate-x-1/2">
              <span className="bg-secondary text-secondary-foreground text-xs font-bold px-3 py-1 rounded-full">
                Best value
              </span>
            </div>
          )}

          <div className="flex items-center gap-2">
            <Zap size={16} className="text-secondary" />
            <span className="font-bold text-foreground">{bundle.credits.toLocaleString()} credits</span>
          </div>

          <div>
            <p className="text-2xl font-bold">{bundle.price}</p>
            <p className="text-xs text-muted-foreground">{bundle.priceLabel}</p>
          </div>

          <DodoCheckoutButton
            planType="topup"
            topupProductId={bundle.productId}
            label={`Buy ${bundle.credits.toLocaleString()} Credits`}
            size="sm"
            variant={bundle.popular ? "default" : "outline"}
            className={bundle.popular ? "bg-secondary hover:bg-secondary/90 text-secondary-foreground" : ""}
            onSuccess={onPurchased}
          />
        </div>
      ))}
    </div>
  );
}