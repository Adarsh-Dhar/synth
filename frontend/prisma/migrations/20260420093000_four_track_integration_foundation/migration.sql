-- Four-track integration foundation
-- GoldRush + Dodo + MagicBlock + Umbra additive schema updates

ALTER TABLE "User"
  ADD COLUMN "subscriptionTier" TEXT NOT NULL DEFAULT 'FREE',
  ADD COLUMN "monthlyUsageUnits" INTEGER NOT NULL DEFAULT 0;

ALTER TABLE "Agent"
  ADD COLUMN "magicBlockValidatorEndpoint" TEXT,
  ADD COLUMN "privateExecutionEnabled" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "umbraShieldedMint" TEXT,
  ADD COLUMN "goldrushPortfolioSnapshot" JSONB;

CREATE INDEX "Subscription_agentId_status_idx" ON "Subscription"("agentId", "status");
CREATE INDEX "Subscription_provider_plan_idx" ON "Subscription"("provider", "plan");
