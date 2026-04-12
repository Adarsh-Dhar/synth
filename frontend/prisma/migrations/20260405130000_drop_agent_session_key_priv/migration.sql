-- Remove persisted session private key material from Agent records.
ALTER TABLE "Agent"
DROP COLUMN IF EXISTS "sessionKeyPriv";
