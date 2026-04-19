"use client";

import React from "react";
import { Button } from "@/components/ui/button";

type Props = {
  title: string;
  priceLabel: string;
  features: string[];
  ctaLabel?: string;
  onSelect?: () => void;
};

export function PricingCard({ title, priceLabel, features, ctaLabel = "Choose Plan", onSelect }: Props) {
  return (
    <div className="rounded-lg border border-border bg-card p-5">
      <h3 className="text-lg font-semibold text-foreground">{title}</h3>
      <p className="text-2xl font-bold mt-2">{priceLabel}</p>
      <ul className="mt-4 space-y-1 text-sm text-muted-foreground">
        {features.map((feature) => (
          <li key={feature}>• {feature}</li>
        ))}
      </ul>
      <Button className="mt-5 w-full" onClick={onSelect}>{ctaLabel}</Button>
    </div>
  );
}
