"use client";

/**
 * frontend/components/dodo-checkout-button.tsx
 *
 * Drop-in checkout trigger for any plan or top-up product.
 * Opens Dodo Overlay Checkout so users never leave the page.
 *
 * Usage:
 *   <DodoCheckoutButton planType="pro" />
 *   <DodoCheckoutButton planType="topup" topupProductId={TOPUP_ID} label="Buy 500 Credits ($5)" />
 */

import { useState, useCallback } from "react";
import { Button } from "@/components/ui/button";
import { Loader2, Zap } from "lucide-react";
import { useUser } from "@/lib/user-context";
import { getWalletAuthHeaders } from "@/lib/auth/client";

export type PlanType = "pro" | "enterprise" | "topup";

interface DodoCheckoutButtonProps {
  planType: PlanType;
  topupProductId?: string;
  label?: string;
  className?: string;
  variant?: "default" | "outline" | "ghost";
  size?: "sm" | "default" | "lg";
  onSuccess?: () => void;
  onClose?: () => void;
  disabled?: boolean;
}

export function DodoCheckoutButton({
  planType,
  topupProductId,
  label,
  className,
  variant = "default",
  size = "default",
  onSuccess,
  onClose,
  disabled = false,
}: DodoCheckoutButtonProps) {
  const { walletSigner } = useUser();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const defaultLabels: Record<PlanType, string> = {
    pro: "Upgrade to Pro",
    enterprise: "Upgrade to Enterprise",
    topup: "Buy Credits",
  };

  const displayLabel = label ?? defaultLabels[planType];

  const handleClick = useCallback(async () => {
    setLoading(true);
    setError(null);

    try {
      const authHeaders = await getWalletAuthHeaders(walletSigner);

      const body: Record<string, unknown> = { planType };
      if (planType === "topup" && topupProductId) {
        body.productId = topupProductId;
      }

      const res = await fetch("/api/payments/checkout", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(authHeaders ?? {}) },
        body: JSON.stringify(body),
      });

      const data = (await res.json()) as {
        checkoutUrl?: string;
        error?: string;
        detail?: unknown;
      };

      if (!res.ok || !data.checkoutUrl) {
        throw new Error(data.error ?? "Failed to create checkout session");
      }

      // Use Dodo Overlay if available, fall back to redirect
      if (typeof window !== "undefined" && window.DodoOverlay) {
        window.DodoOverlay.open(data.checkoutUrl, {
          onSuccess: (result) => {
            console.log("[Dodo] Payment succeeded:", result);
            onSuccess?.();
          },
          onClose: () => {
            onClose?.();
          },
          onError: (err) => {
            setError(err.message);
          },
        });
      } else {
        // Fallback: open in same tab
        window.location.href = data.checkoutUrl;
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Checkout failed");
    } finally {
      setLoading(false);
    }
  }, [planType, topupProductId, walletSigner, onSuccess, onClose]);

  return (
    <div className="flex flex-col gap-1">
      <Button
        variant={variant}
        size={size}
        onClick={handleClick}
        disabled={disabled || loading}
        className={className}
      >
        {loading ? (
          <>
            <Loader2 size={14} className="mr-2 animate-spin" />
            Opening checkout…
          </>
        ) : (
          <>
            <Zap size={14} className="mr-2" />
            {displayLabel}
          </>
        )}
      </Button>
      {error && (
        <p className="text-xs text-destructive">{error}</p>
      )}
    </div>
  );
}