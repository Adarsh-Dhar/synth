"use client";

import React from "react";
import { Badge } from "@/components/ui/badge";
import { ShieldCheck } from "lucide-react";

type GoldRushSecurityBadgeProps = {
  verified?: boolean;
  threatType?: "lp_pull" | "drainer_approval" | "phishing_airdrop" | null;
  compact?: boolean;
};

function formatThreatLabel(threatType: NonNullable<GoldRushSecurityBadgeProps["threatType"]>): string {
  if (threatType === "lp_pull") return "LP Pull";
  if (threatType === "drainer_approval") return "Drainer Approval";
  return "Phishing Airdrop";
}

export function GoldRushSecurityBadge({ verified = true, threatType = null, compact = false }: GoldRushSecurityBadgeProps) {
  const danger = Boolean(threatType);

  return (
    <Badge
      className={
        danger
          ? "bg-red-500/15 text-red-300 border border-red-500/30"
          : verified
          ? "bg-emerald-500/15 text-emerald-300 border border-emerald-500/30"
          : "bg-amber-500/15 text-amber-300 border border-amber-500/30"
      }
    >
      <ShieldCheck size={compact ? 12 : 13} className="mr-1" />
      {danger ? `Threat: ${formatThreatLabel(threatType as NonNullable<GoldRushSecurityBadgeProps["threatType"]>)}` : verified ? "GoldRush Verified" : "GoldRush Pending"}
    </Badge>
  );
}
