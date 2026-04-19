"use client";

import React from "react";

export default function PrivacyCenterPage() {
  return (
    <div className="min-h-screen bg-background p-6 lg:p-8">
      <div className="max-w-4xl mx-auto space-y-6">
        <div>
          <h1 className="text-3xl font-bold text-foreground">Privacy Center</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Configure Umbra shielding and MagicBlock private execution for your agents.
          </p>
        </div>

        <div className="bg-card border border-border rounded-lg p-6">
          <h2 className="text-lg font-semibold text-foreground">Umbra</h2>
          <p className="text-sm text-muted-foreground mt-1">
            Shield balances, manage viewing grants, and route privacy-sensitive transfers.
          </p>
        </div>

        <div className="bg-card border border-border rounded-lg p-6">
          <h2 className="text-lg font-semibold text-foreground">MagicBlock</h2>
          <p className="text-sm text-muted-foreground mt-1">
            Monitor TEE validator sessions and private transfer execution state.
          </p>
        </div>
      </div>
    </div>
  );
}
