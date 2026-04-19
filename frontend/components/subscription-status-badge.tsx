"use client";

import React from "react";
import { Badge } from "@/components/ui/badge";

type Props = {
  tier?: string;
};

const tierStyle: Record<string, string> = {
  FREE: "bg-slate-500/15 text-slate-300 border border-slate-500/30",
  PRO: "bg-blue-500/15 text-blue-300 border border-blue-500/30",
  ENTERPRISE: "bg-amber-500/15 text-amber-300 border border-amber-500/30",
};

export function SubscriptionStatusBadge({ tier = "FREE" }: Props) {
  const normalized = tier.toUpperCase();
  return <Badge className={tierStyle[normalized] ?? tierStyle.FREE}>{normalized}</Badge>;
}
