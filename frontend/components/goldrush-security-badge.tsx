"use client";

import React from "react";
import { Badge } from "@/components/ui/badge";
import { ShieldCheck } from "lucide-react";

type GoldRushSecurityBadgeProps = {
  verified?: boolean;
  compact?: boolean;
};

export function GoldRushSecurityBadge({ verified = true, compact = false }: GoldRushSecurityBadgeProps) {
  return (
    <Badge
      className={
        verified
          ? "bg-emerald-500/15 text-emerald-300 border border-emerald-500/30"
          : "bg-amber-500/15 text-amber-300 border border-amber-500/30"
      }
    >
      <ShieldCheck size={compact ? 12 : 13} className="mr-1" />
      {verified ? "GoldRush Verified" : "GoldRush Pending"}
    </Badge>
  );
}
