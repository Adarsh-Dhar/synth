"use client";

import { useCallback } from "react";
import { useUser } from "@/lib/user-context";
import { getWalletAuthHeaders } from "@/lib/auth/client";

export function useUsageReporting() {
  const { walletSigner } = useUser();

  return useCallback(
    async (usageUnits: number) => {
      const authHeaders = await getWalletAuthHeaders(walletSigner);
      await fetch("/api/payments/usage", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(authHeaders ?? {}),
        },
        body: JSON.stringify({ usageUnits }),
      });
    },
    [walletSigner],
  );
}
