"use client";

/**
 * frontend/app/dashboard/pricing/page.tsx
 *
 * Standalone pricing page — shows all plans and top-up bundles.
 */

import React from "react";
import { useRouter } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { Button } from "@/components/ui/button";
import { PricingPlans, CreditTopups } from "@/components/pricing-plans";
import { useUser } from "@/lib/user-context";
import { useDodoSubscription } from "@/hooks/use-dodo-subscription";

export default function PricingPage() {
  const router = useRouter();
  const { user } = useUser();
  const { tier } = useDodoSubscription();

  const handleUpgraded = () => {
    setTimeout(() => router.push("/dashboard/billing?dodo=success"), 1500);
  };

  return (
    <div className="min-h-screen bg-background">
      <div className="sticky top-0 z-30 bg-background border-b border-border">
        <div className="px-6 py-4 lg:px-8 flex items-center gap-4">
          <Button variant="ghost" size="sm" onClick={() => router.back()}>
            <ArrowLeft size={16} className="mr-1" /> Back
          </Button>
          <div>
            <h1 className="text-2xl font-bold">Plans & Pricing</h1>
            <p className="text-sm text-muted-foreground">Choose the right tier for your trading needs</p>
          </div>
        </div>
      </div>

      <div className="px-6 py-12 lg:px-8 max-w-5xl mx-auto space-y-16">
        {/* Subscription plans */}
        <section>
          <div className="text-center mb-10">
            <h2 className="text-4xl font-bold">Simple, transparent pricing</h2>
            <p className="text-muted-foreground mt-3 max-w-xl mx-auto">
              Start free. Scale as your strategy grows. Dodo handles billing globally — no hidden fees.
            </p>
          </div>
          <PricingPlans currentTier={tier} onUpgraded={handleUpgraded} />
        </section>

        {/* Credit top-ups */}
        <section>
          <div className="text-center mb-8">
            <h2 className="text-2xl font-bold">Need more credits?</h2>
            <p className="text-muted-foreground mt-2">
              Buy a one-time top-up without changing your subscription.
            </p>
          </div>
          <CreditTopups onPurchased={handleUpgraded} />
        </section>

        {/* FAQ */}
        <section className="max-w-2xl mx-auto space-y-6">
          <h2 className="text-xl font-bold text-center">Frequently Asked Questions</h2>
          {[
            {
              q: "What are credits used for?",
              a: "Each bot generation costs 50 credits. Running bots consume credits at ~1 credit/hour. Credits roll over within the same plan tier.",
            },
            {
              q: "Can I cancel at any time?",
              a: "Yes. Click 'Manage Subscription' on the billing page to cancel via the Dodo customer portal. Your plan stays active until the period ends.",
            },
            {
              q: "What payment methods are accepted?",
              a: "Dodo Payments accepts credit/debit cards, local payment methods, and 80+ currencies across 150+ countries.",
            },
            {
              q: "Is my payment information stored?",
              a: "No. Synth never sees your card details. All payment processing is handled by Dodo Payments, our Merchant of Record.",
            },
          ].map(({ q, a }) => (
            <div key={q} className="bg-card border border-border rounded-lg p-5">
              <p className="font-semibold text-foreground text-sm">{q}</p>
              <p className="text-sm text-muted-foreground mt-2 leading-relaxed">{a}</p>
            </div>
          ))}
        </section>
      </div>
    </div>
  );
}