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
    const currentPlan = user?.plan || user?.subscriptionTier || "FREE";
    setState({
      tier: currentPlan,
      monthlyUsageUnits: user?.monthlyUsageUnits || 0,
      loading,
    });
  }, [user, loading]);

  return state;
}
