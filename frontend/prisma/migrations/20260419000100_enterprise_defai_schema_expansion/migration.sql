-- Enterprise DeFAI Engine schema expansion
-- 1) Add privacy/session fields to Agent
-- 2) Remove EVM legacy TradeLog field (profitEth)
-- 3) Add Subscription model for Dodo commerce webhooks

ALTER TABLE "Agent"
  ADD COLUMN "umbraViewingKey" TEXT,
  ADD COLUMN "umbraSpendingKey" TEXT,
  ADD COLUMN "magicBlockSessionId" TEXT;

ALTER TABLE "TradeLog"
  DROP COLUMN IF EXISTS "profitEth";

CREATE TABLE "Subscription" (
  "id" TEXT NOT NULL,
  "agentId" TEXT NOT NULL,
  "provider" TEXT NOT NULL,
  "status" TEXT NOT NULL,
  "externalReference" TEXT NOT NULL,
  "plan" TEXT,
  "webhookUrl" TEXT,
  "validUntil" TIMESTAMP(3),
  "metadata" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "Subscription_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "Subscription_externalReference_key" ON "Subscription"("externalReference");
CREATE INDEX "Subscription_agentId_provider_idx" ON "Subscription"("agentId", "provider");
CREATE INDEX "Subscription_status_idx" ON "Subscription"("status");

ALTER TABLE "Subscription"
  ADD CONSTRAINT "Subscription_agentId_fkey"
  FOREIGN KEY ("agentId") REFERENCES "Agent"("id") ON DELETE CASCADE ON UPDATE CASCADE;
