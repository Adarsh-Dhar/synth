"use client";

import React from "react";

type Props = {
  value: number;
  max: number;
  label?: string;
};

export function UsageMeter({ value, max, label = "Usage" }: Props) {
  const pct = max > 0 ? Math.min(100, Math.round((value / max) * 100)) : 0;
  return (
    <div className="rounded-lg border border-border p-4">
      <div className="flex items-center justify-between text-sm mb-2">
        <span className="text-muted-foreground">{label}</span>
        <span className="font-medium">{value} / {max}</span>
      </div>
      <div className="h-2 rounded bg-muted overflow-hidden">
        <div className="h-full bg-primary" style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}
