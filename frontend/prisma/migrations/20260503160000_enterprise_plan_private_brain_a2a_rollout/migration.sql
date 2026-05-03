-- Enterprise plan + private brain / shielded execution / A2A rollout

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
