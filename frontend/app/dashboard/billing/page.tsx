"use client";

import React from "react";
import { useUser } from "@/lib/user-context";
import { SubscriptionStatusBadge } from "@/components/subscription-status-badge";

export default function BillingPage() {
  const { user } = useUser();

  return (
    <div className="min-h-screen bg-background p-6 lg:p-8">
      <div className="max-w-4xl mx-auto space-y-6">
        <div>
          <h1 className="text-3xl font-bold text-foreground">Billing</h1>
          <p className="text-sm text-muted-foreground mt-1">Dodo-powered subscription and usage overview.</p>
        </div>

        <div className="bg-card border border-border rounded-lg p-6">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-xs text-muted-foreground">Current Tier</p>
              <p className="text-xl font-semibold text-foreground mt-1">{user?.subscriptionTier ?? "FREE"}</p>
            </div>
            <SubscriptionStatusBadge tier={user?.subscriptionTier ?? "FREE"} />
          </div>

          <div className="mt-6 grid grid-cols-1 md:grid-cols-2 gap-4">
            <div className="rounded-lg border border-border p-4">
              <p className="text-xs text-muted-foreground">Monthly Usage Units</p>
              <p className="text-2xl font-bold mt-1">{user?.monthlyUsageUnits ?? 0}</p>
            </div>
            <div className="rounded-lg border border-border p-4">
              <p className="text-xs text-muted-foreground">Plan Status</p>
              <p className="text-2xl font-bold mt-1">Active</p>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
