"use client";

import { useEffect, useState } from "react";
import { useUser } from "@/lib/user-context";

type SubscriptionState = {
  tier: string;
  monthlyUsageUnits: number;
  loading: boolean;
};

export function useSubscription(): SubscriptionState {
  const { user, loading } = useUser();
  const [state, setState] = useState<SubscriptionState>({
    tier: "FREE",
    monthlyUsageUnits: 0,
    loading: true,
  });

  useEffect(() => {
    setState({
      tier: user?.subscriptionTier || "FREE",
      monthlyUsageUnits: user?.monthlyUsageUnits || 0,
      loading,
    });
  }, [user, loading]);

  return state;
}
