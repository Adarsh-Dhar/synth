-- Enterprise plan + private brain / shielded execution / A2A rollout

-- ============================================================
-- 0. Ensure required tables exist (dev bootstrap)
-- ============================================================
CREATE TABLE IF NOT EXISTS "PrivateBrainConfig" (
  "id" TEXT NOT NULL,
  "agentId" TEXT NOT NULL,
  "ownerId" TEXT NOT NULL,
  "privateBrainEnabled" BOOLEAN NOT NULL DEFAULT FALSE,
  "perValidator" TEXT NOT NULL,
  "perValidatorPubkey" TEXT NOT NULL,
  "memorySlots" INTEGER NOT NULL DEFAULT 8,
  "geofenceRegions" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "ofacCheckEnabled" BOOLEAN NOT NULL DEFAULT TRUE,
  "status" TEXT NOT NULL DEFAULT 'inactive',
  "stateAccountPubkey" TEXT,
  "permissionAccountPubkey" TEXT,
  "delegationTxSignature" TEXT,
  "undelegationTxSignature" TEXT,
  "errorMessage" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "PrivateBrainConfig_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "PrivateBrainConfig"
  ADD CONSTRAINT "PrivateBrainConfig_agentId_fkey"
  FOREIGN KEY ("agentId") REFERENCES "Agent"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "PrivateBrainConfig"
  ADD CONSTRAINT "PrivateBrainConfig_ownerId_fkey"
  FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE IF NOT EXISTS "PrivateBrainAudit" (
  "id" TEXT NOT NULL,
  "configId" TEXT NOT NULL,
  "agentId" TEXT NOT NULL,
  "actorId" TEXT NOT NULL,
  "action" TEXT NOT NULL,
  "previousStatus" TEXT,
  "newStatus" TEXT,
  "metadata" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "PrivateBrainAudit_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "PrivateBrainAudit"
  ADD CONSTRAINT "PrivateBrainAudit_configId_fkey"
  FOREIGN KEY ("configId") REFERENCES "PrivateBrainConfig"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "PrivateBrainAudit"
  ADD CONSTRAINT "PrivateBrainAudit_agentId_fkey"
  FOREIGN KEY ("agentId") REFERENCES "Agent"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "PrivateBrainAudit"
  ADD CONSTRAINT "PrivateBrainAudit_actorId_fkey"
  FOREIGN KEY ("actorId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE IF NOT EXISTS "ShieldedExecutionConfig" (
  "id" TEXT NOT NULL,
  "agentId" TEXT NOT NULL,
  "ownerId" TEXT NOT NULL,
  "enabled" BOOLEAN NOT NULL DEFAULT FALSE,
  "perValidator" TEXT NOT NULL,
  "perValidatorPubkey" TEXT NOT NULL,
  "shieldStrategyLogic" BOOLEAN NOT NULL DEFAULT TRUE,
  "shieldIntent" BOOLEAN NOT NULL DEFAULT TRUE,
  "shieldIntermediateStates" BOOLEAN NOT NULL DEFAULT TRUE,
  "settlementMode" TEXT NOT NULL DEFAULT 'net_only',
  "settlementIntervalMs" INTEGER NOT NULL DEFAULT 0,
  "status" TEXT NOT NULL DEFAULT 'inactive',
  "logicAccountPubkey" TEXT,
  "stateAccountPubkey" TEXT,
  "permissionAccountPubkey" TEXT,
  "delegationTxSignature" TEXT,
  "errorMessage" TEXT,
  "totalShieldedOps" BIGINT NOT NULL DEFAULT 0,
  "totalSettledTxs" INTEGER NOT NULL DEFAULT 0,
  "lastSettlementAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "ShieldedExecutionConfig_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "ShieldedExecutionConfig"
  ADD CONSTRAINT "ShieldedExecutionConfig_agentId_fkey"
  FOREIGN KEY ("agentId") REFERENCES "Agent"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ShieldedExecutionConfig"
  ADD CONSTRAINT "ShieldedExecutionConfig_ownerId_fkey"
  FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE IF NOT EXISTS "ShieldedExecutionAudit" (
  "id" TEXT NOT NULL,
  "configId" TEXT NOT NULL,
  "agentId" TEXT NOT NULL,
  "actorId" TEXT NOT NULL,
  "action" TEXT NOT NULL,
  "previousStatus" TEXT,
  "newStatus" TEXT,
  "metadata" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "ShieldedExecutionAudit_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "ShieldedExecutionAudit"
  ADD CONSTRAINT "ShieldedExecutionAudit_configId_fkey"
  FOREIGN KEY ("configId") REFERENCES "ShieldedExecutionConfig"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ShieldedExecutionAudit"
  ADD CONSTRAINT "ShieldedExecutionAudit_agentId_fkey"
  FOREIGN KEY ("agentId") REFERENCES "Agent"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ShieldedExecutionAudit"
  ADD CONSTRAINT "ShieldedExecutionAudit_actorId_fkey"
  FOREIGN KEY ("actorId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE IF NOT EXISTS "BotWallet" (
  "id" TEXT NOT NULL,
  "agentId" TEXT NOT NULL,
  "ownerId" TEXT NOT NULL,
  "pubkey" TEXT NOT NULL,
  "encryptedKey" TEXT,
  "solBalanceLamports" BIGINT NOT NULL DEFAULT 0,
  "usdcBalanceMicro" BIGINT NOT NULL DEFAULT 0,
  "privatePaymentsEnabled" BOOLEAN NOT NULL DEFAULT FALSE,
  "paymentApiKeyHash" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "BotWallet_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "BotWallet"
  ADD CONSTRAINT "BotWallet_agentId_fkey"
  FOREIGN KEY ("agentId") REFERENCES "Agent"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "BotWallet"
  ADD CONSTRAINT "BotWallet_ownerId_fkey"
  FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE IF NOT EXISTS "BotService" (
  "id" TEXT NOT NULL,
  "agentId" TEXT NOT NULL,
  "ownerId" TEXT NOT NULL,
  "serviceType" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "description" TEXT,
  "endpointUrl" TEXT,
  "currency" TEXT NOT NULL DEFAULT 'USDC',
  "pricePerCallMicro" INTEGER NOT NULL DEFAULT 0,
  "pricePerSecondMicro" INTEGER NOT NULL DEFAULT 0,
  "isPublic" BOOLEAN NOT NULL DEFAULT FALSE,
  "requiresWhitelist" BOOLEAN NOT NULL DEFAULT FALSE,
  "status" TEXT NOT NULL DEFAULT 'offline',
  "lastHeartbeat" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "BotService_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "BotService"
  ADD CONSTRAINT "BotService_agentId_fkey"
  FOREIGN KEY ("agentId") REFERENCES "Agent"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "BotService"
  ADD CONSTRAINT "BotService_ownerId_fkey"
  FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE IF NOT EXISTS "BotServiceWhitelist" (
  "id" TEXT NOT NULL,
  "serviceId" TEXT NOT NULL,
  "allowedAgentId" TEXT NOT NULL,
  "grantedBy" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "BotServiceWhitelist_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "BotServiceWhitelist"
  ADD CONSTRAINT "BotServiceWhitelist_serviceId_fkey"
  FOREIGN KEY ("serviceId") REFERENCES "BotService"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "BotServiceWhitelist"
  ADD CONSTRAINT "BotServiceWhitelist_allowedAgentId_fkey"
  FOREIGN KEY ("allowedAgentId") REFERENCES "Agent"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE UNIQUE INDEX IF NOT EXISTS "BotServiceWhitelist_serviceId_allowedAgentId_key"
  ON "BotServiceWhitelist" ("serviceId", "allowedAgentId");

CREATE INDEX IF NOT EXISTS "BotServiceWhitelist_allowedAgentId_idx"
  ON "BotServiceWhitelist" ("allowedAgentId");

CREATE TABLE IF NOT EXISTS "A2APaymentChannel" (
  "id" TEXT NOT NULL,
  "payerAgentId" TEXT NOT NULL,
  "payeeAgentId" TEXT NOT NULL,
  "serviceId" TEXT,
  "currency" TEXT NOT NULL DEFAULT 'USDC',
  "maxPerTxMicro" INTEGER NOT NULL DEFAULT 1000000,
  "dailyCapMicro" INTEGER NOT NULL DEFAULT 100000000,
  "status" TEXT NOT NULL DEFAULT 'pending',
  "channelAccountPubkey" TEXT,
  "openTxSignature" TEXT,
  "openedAt" TIMESTAMP(3),
  "closeTxSignature" TEXT,
  "closedAt" TIMESTAMP(3),
  "totalPaidMicro" INTEGER NOT NULL DEFAULT 0,
  "totalTxCount" INTEGER NOT NULL DEFAULT 0,
  "lastPaymentAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "A2APaymentChannel_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "A2APaymentChannel"
  ADD CONSTRAINT "A2APaymentChannel_payerAgentId_fkey"
  FOREIGN KEY ("payerAgentId") REFERENCES "Agent"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "A2APaymentChannel"
  ADD CONSTRAINT "A2APaymentChannel_payeeAgentId_fkey"
  FOREIGN KEY ("payeeAgentId") REFERENCES "Agent"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "A2APaymentChannel"
  ADD CONSTRAINT "A2APaymentChannel_serviceId_fkey"
  FOREIGN KEY ("serviceId") REFERENCES "BotService"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE IF NOT EXISTS "A2APayment" (
  "id" TEXT NOT NULL,
  "channelId" TEXT NOT NULL,
  "payerAgentId" TEXT NOT NULL,
  "payeeAgentId" TEXT NOT NULL,
  "amountMicro" INTEGER NOT NULL,
  "currency" TEXT NOT NULL,
  "purpose" TEXT NOT NULL,
  "idempotencyKey" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'pending',
  "txSignature" TEXT,
  "slot" INTEGER,
  "confirmedAt" TIMESTAMP(3),
  "failedReason" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "A2APayment_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "A2APayment"
  ADD CONSTRAINT "A2APayment_channelId_fkey"
  FOREIGN KEY ("channelId") REFERENCES "A2APaymentChannel"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "A2APayment"
  ADD CONSTRAINT "A2APayment_payerAgentId_fkey"
  FOREIGN KEY ("payerAgentId") REFERENCES "Agent"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "A2APayment"
  ADD CONSTRAINT "A2APayment_payeeAgentId_fkey"
  FOREIGN KEY ("payeeAgentId") REFERENCES "Agent"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE UNIQUE INDEX IF NOT EXISTS "A2APayment_idempotencyKey_key"
  ON "A2APayment" ("idempotencyKey");

CREATE SCHEMA IF NOT EXISTS auth;

CREATE OR REPLACE FUNCTION auth.uid()
RETURNS TEXT LANGUAGE sql STABLE AS $$
  SELECT NULL::TEXT;
$$;

-- ============================================================
-- 1. User plan columns
-- ============================================================
ALTER TABLE "User"
  ADD COLUMN IF NOT EXISTS "plan" TEXT NOT NULL DEFAULT 'free',
  ADD COLUMN IF NOT EXISTS "planStartedAt" TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS "planExpiresAt" TIMESTAMPTZ;

UPDATE "User"
   SET "plan" = LOWER(COALESCE("subscriptionTier", 'FREE')),
       "planStartedAt" = COALESCE("planStartedAt", "createdAt")
 WHERE "plan" IS NULL OR "plan" = 'free';

CREATE INDEX IF NOT EXISTS "User_plan_idx" ON "User"("plan");

-- ============================================================
-- 2. Private Brain config hardening
-- ============================================================
ALTER TABLE "PrivateBrainConfig"
  ADD COLUMN IF NOT EXISTS "undelegationTxSignature" TEXT,
  ADD COLUMN IF NOT EXISTS "errorMessage" TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS "PrivateBrainConfig_agentId_key"
  ON "PrivateBrainConfig" ("agentId");
CREATE INDEX IF NOT EXISTS "PrivateBrainConfig_ownerId_idx"
  ON "PrivateBrainConfig" ("ownerId");
CREATE INDEX IF NOT EXISTS "PrivateBrainConfig_status_idx"
  ON "PrivateBrainConfig" ("status");

ALTER TABLE "PrivateBrainAudit"
  ALTER COLUMN "metadata" SET DEFAULT '{}'::jsonb;

ALTER TABLE "PrivateBrainConfig" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS private_brain_owner_select ON "PrivateBrainConfig";
CREATE POLICY private_brain_owner_select
  ON "PrivateBrainConfig" FOR SELECT
  USING ("ownerId" = auth.uid());

DROP POLICY IF EXISTS private_brain_insert ON "PrivateBrainConfig";
CREATE POLICY private_brain_insert
  ON "PrivateBrainConfig" FOR INSERT
  WITH CHECK (
    "ownerId" = auth.uid()
    AND (
      "privateBrainEnabled" = FALSE
      OR EXISTS (
        SELECT 1
          FROM "User"
         WHERE id = auth.uid()
           AND plan = 'enterprise'
           AND ("planExpiresAt" IS NULL OR "planExpiresAt" > now())
      )
    )
  );

DROP POLICY IF EXISTS private_brain_update ON "PrivateBrainConfig";
CREATE POLICY private_brain_update
  ON "PrivateBrainConfig" FOR UPDATE
  USING ("ownerId" = auth.uid())
  WITH CHECK (
    "ownerId" = auth.uid()
    AND (
      "privateBrainEnabled" = FALSE
      OR EXISTS (
        SELECT 1
          FROM "User"
         WHERE id = auth.uid()
           AND plan = 'enterprise'
           AND ("planExpiresAt" IS NULL OR "planExpiresAt" > now())
      )
    )
  );

DROP POLICY IF EXISTS private_brain_delete ON "PrivateBrainConfig";
CREATE POLICY private_brain_delete
  ON "PrivateBrainConfig" FOR DELETE
  USING ("ownerId" = auth.uid());

CREATE OR REPLACE FUNCTION enforce_private_brain_plan()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.plan <> 'enterprise' AND OLD.plan = 'enterprise' THEN
    WITH affected AS (
      SELECT id, "agentId", "status"
        FROM "PrivateBrainConfig"
       WHERE "ownerId" = NEW.id
         AND "privateBrainEnabled" = TRUE
    ), updated AS (
      UPDATE "PrivateBrainConfig"
         SET "privateBrainEnabled" = FALSE,
             "status" = 'inactive',
             "updatedAt" = now()
       WHERE id IN (SELECT id FROM affected)
       RETURNING id
    )
    INSERT INTO "PrivateBrainAudit" ("configId", "agentId", "actorId", action, "previousStatus", "newStatus", metadata, "createdAt")
    SELECT affected.id,
           affected."agentId",
           NEW.id,
           'disable',
           affected.status,
           'inactive',
           jsonb_build_object('reason', 'plan_downgrade', 'previous_plan', OLD.plan, 'new_plan', NEW.plan),
           now()
      FROM affected
      INNER JOIN updated USING (id);
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_enforce_private_brain_plan ON "User";
CREATE TRIGGER trg_enforce_private_brain_plan
  AFTER UPDATE OF plan ON "User"
  FOR EACH ROW
  EXECUTE FUNCTION enforce_private_brain_plan();

-- ============================================================
-- 3. Shielded execution + A2A tables
-- ============================================================
ALTER TABLE "ShieldedExecutionConfig"
  ADD COLUMN IF NOT EXISTS "errorMessage" TEXT,
  ADD COLUMN IF NOT EXISTS "totalShieldedOps" BIGINT NOT NULL DEFAULT 0;

CREATE UNIQUE INDEX IF NOT EXISTS "ShieldedExecutionConfig_agentId_key"
  ON "ShieldedExecutionConfig" ("agentId");
CREATE INDEX IF NOT EXISTS "ShieldedExecutionConfig_ownerId_idx"
  ON "ShieldedExecutionConfig" ("ownerId");
CREATE INDEX IF NOT EXISTS "ShieldedExecutionConfig_status_idx"
  ON "ShieldedExecutionConfig" ("status");

ALTER TABLE "ShieldedExecutionConfig" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS shielded_owner_select ON "ShieldedExecutionConfig";
CREATE POLICY shielded_owner_select ON "ShieldedExecutionConfig" FOR SELECT
  USING ("ownerId" = auth.uid());

DROP POLICY IF EXISTS shielded_insert ON "ShieldedExecutionConfig";
CREATE POLICY shielded_insert ON "ShieldedExecutionConfig" FOR INSERT
  WITH CHECK (
    "ownerId" = auth.uid()
    AND (
      "enabled" = FALSE
      OR EXISTS (
        SELECT 1 FROM "User"
         WHERE id = auth.uid() AND plan = 'enterprise'
           AND ("planExpiresAt" IS NULL OR "planExpiresAt" > now())
      )
    )
  );

DROP POLICY IF EXISTS shielded_update ON "ShieldedExecutionConfig";
CREATE POLICY shielded_update ON "ShieldedExecutionConfig" FOR UPDATE
  USING ("ownerId" = auth.uid())
  WITH CHECK (
    "ownerId" = auth.uid()
    AND (
      "enabled" = FALSE
      OR EXISTS (
        SELECT 1 FROM "User"
         WHERE id = auth.uid() AND plan = 'enterprise'
           AND ("planExpiresAt" IS NULL OR "planExpiresAt" > now())
      )
    )
  );

DROP POLICY IF EXISTS shielded_delete ON "ShieldedExecutionConfig";
CREATE POLICY shielded_delete ON "ShieldedExecutionConfig" FOR DELETE
  USING ("ownerId" = auth.uid());

ALTER TABLE "BotWallet"
  ADD COLUMN IF NOT EXISTS "encryptedKey" TEXT,
  ADD COLUMN IF NOT EXISTS "solBalanceLamports" BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "usdcBalanceMicro" BIGINT NOT NULL DEFAULT 0;

CREATE UNIQUE INDEX IF NOT EXISTS "BotWallet_pubkey_key" ON "BotWallet" ("pubkey");
CREATE INDEX IF NOT EXISTS "BotWallet_ownerId_idx" ON "BotWallet" ("ownerId");

ALTER TABLE "BotService" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS service_owner ON "BotService";
CREATE POLICY service_owner ON "BotService" FOR ALL
  USING ("ownerId" = auth.uid())
  WITH CHECK ("ownerId" = auth.uid());

DROP POLICY IF EXISTS service_public ON "BotService";
CREATE POLICY service_public ON "BotService" FOR SELECT
  USING ("isPublic" = TRUE);

ALTER TABLE "A2APaymentChannel"
  ADD COLUMN IF NOT EXISTS "closeTxSignature" TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS "A2APaymentChannel_pair_key"
  ON "A2APaymentChannel" ("payerAgentId", "payeeAgentId", "serviceId")
  WHERE "status" IN ('pending', 'open');
CREATE INDEX IF NOT EXISTS "A2APaymentChannel_payerAgentId_idx" ON "A2APaymentChannel" ("payerAgentId");
CREATE INDEX IF NOT EXISTS "A2APaymentChannel_payeeAgentId_idx" ON "A2APaymentChannel" ("payeeAgentId");
CREATE INDEX IF NOT EXISTS "A2APaymentChannel_status_idx" ON "A2APaymentChannel" ("status");

ALTER TABLE "A2APayment"
  ADD COLUMN IF NOT EXISTS "failedReason" TEXT;

CREATE INDEX IF NOT EXISTS "A2APayment_channelId_createdAt_idx"
  ON "A2APayment" ("channelId", "createdAt" DESC);
CREATE INDEX IF NOT EXISTS "A2APayment_payerAgentId_createdAt_idx"
  ON "A2APayment" ("payerAgentId", "createdAt" DESC);
CREATE INDEX IF NOT EXISTS "A2APayment_payeeAgentId_createdAt_idx"
  ON "A2APayment" ("payeeAgentId", "createdAt" DESC);
CREATE INDEX IF NOT EXISTS "A2APayment_status_idx"
  ON "A2APayment" ("status");

ALTER TABLE "A2APaymentChannel" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "A2APayment" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "BotServiceWhitelist" ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS channel_payer ON "A2APaymentChannel";
CREATE POLICY channel_payer ON "A2APaymentChannel" FOR SELECT
  USING ("payerAgentId" IN (SELECT id FROM "Agent" WHERE "userId" = auth.uid()));

DROP POLICY IF EXISTS channel_payee ON "A2APaymentChannel";
CREATE POLICY channel_payee ON "A2APaymentChannel" FOR SELECT
  USING ("payeeAgentId" IN (SELECT id FROM "Agent" WHERE "userId" = auth.uid()));

DROP POLICY IF EXISTS payment_payer ON "A2APayment";
CREATE POLICY payment_payer ON "A2APayment" FOR SELECT
  USING ("payerAgentId" IN (SELECT id FROM "Agent" WHERE "userId" = auth.uid()));

DROP POLICY IF EXISTS payment_payee ON "A2APayment";
CREATE POLICY payment_payee ON "A2APayment" FOR SELECT
  USING ("payeeAgentId" IN (SELECT id FROM "Agent" WHERE "userId" = auth.uid()));

DROP POLICY IF EXISTS whitelist_owner ON "BotServiceWhitelist";
CREATE POLICY whitelist_owner ON "BotServiceWhitelist" FOR ALL
  USING ("grantedBy" = auth.uid())
  WITH CHECK ("grantedBy" = auth.uid());

CREATE OR REPLACE FUNCTION enforce_enterprise_features_on_downgrade()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.plan <> 'enterprise' AND OLD.plan = 'enterprise' THEN
    UPDATE "ShieldedExecutionConfig"
       SET "enabled" = FALSE,
           "status" = 'suspended',
           "updatedAt" = now()
     WHERE "ownerId" = NEW.id
       AND "enabled" = TRUE;

    UPDATE "BotWallet"
       SET "privatePaymentsEnabled" = FALSE,
           "updatedAt" = now()
     WHERE "ownerId" = NEW.id
       AND "privatePaymentsEnabled" = TRUE;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_enterprise_downgrade ON "User";
CREATE TRIGGER trg_enterprise_downgrade
  AFTER UPDATE OF plan ON "User"
  FOR EACH ROW
  EXECUTE FUNCTION enforce_enterprise_features_on_downgrade();

-- ============================================================
-- 4. updated_at trigger helper
-- ============================================================
CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW."updatedAt" = now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_private_brain_updated_at ON "PrivateBrainConfig";
CREATE TRIGGER trg_private_brain_updated_at
  BEFORE UPDATE ON "PrivateBrainConfig"
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS trg_shielded_updated ON "ShieldedExecutionConfig";
CREATE TRIGGER trg_shielded_updated
  BEFORE UPDATE ON "ShieldedExecutionConfig"
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS trg_wallet_updated ON "BotWallet";
CREATE TRIGGER trg_wallet_updated
  BEFORE UPDATE ON "BotWallet"
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS trg_service_updated ON "BotService";
CREATE TRIGGER trg_service_updated
  BEFORE UPDATE ON "BotService"
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS trg_channel_updated ON "A2APaymentChannel";
CREATE TRIGGER trg_channel_updated
  BEFORE UPDATE ON "A2APaymentChannel"
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
