"use client";

/**
 * frontend/components/dodo-overlay-provider.tsx
 *
 * Injects the Dodo Payments Overlay Checkout JS SDK once globally.
 * Mount this inside your root <Providers> or <body>.
 *
 * After mount, you can call:
 *   window.DodoOverlay?.open(checkoutUrl)
 * from any component.
 */

import { useEffect } from "react";

declare global {
  interface Window {
    DodoOverlay?: {
      open: (checkoutUrl: string, options?: DodoOverlayOptions) => void;
      close: () => void;
    };
  }
}

export interface DodoOverlayOptions {
  /** Called when the payment window closes for any reason */
  onClose?: () => void;
  /** Called when payment succeeds — receives the payment reference */
  onSuccess?: (data: { paymentId: string; status: string }) => void;
  /** Called on payment failure */
  onError?: (error: { message: string }) => void;
}

const DODO_OVERLAY_SRC = "https://checkout.dodopayments.com/overlay.js";

export function DodoOverlayProvider() {
  useEffect(() => {
    if (document.querySelector(`script[src="${DODO_OVERLAY_SRC}"]`)) return;

    const script = document.createElement("script");
    script.src = DODO_OVERLAY_SRC;
    script.async = true;
    script.defer = true;
    document.head.appendChild(script);

    return () => {
      // leave the script loaded — it's shared across the whole app
    };
  }, []);

  return null;
}