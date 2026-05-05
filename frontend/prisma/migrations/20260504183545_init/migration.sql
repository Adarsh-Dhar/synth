-- CreateEnum
CREATE TYPE "AgentStatus" AS ENUM ('STARTING', 'RUNNING', 'STOPPING', 'STOPPED', 'ERROR');

-- CreateEnum
CREATE TYPE "StrategyType" AS ENUM ('MEME_SNIPER', 'ARBITRAGE', 'SENTIMENT_TRADER');

-- CreateEnum
CREATE TYPE "LogType" AS ENUM ('INFO', 'EXECUTION_BUY', 'EXECUTION_SELL', 'PROFIT_SECURED', 'ERROR');

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "name" TEXT,
    "walletAddress" TEXT NOT NULL DEFAULT '',
    "subscriptionTier" TEXT NOT NULL DEFAULT 'FREE',
    "plan" TEXT NOT NULL DEFAULT 'free',
    "planStartedAt" TIMESTAMP(3),
    "planExpiresAt" TIMESTAMP(3),
    "monthlyUsageUnits" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Agent" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "status" "AgentStatus" NOT NULL DEFAULT 'STOPPED',
    "userId" TEXT NOT NULL,
    "walletAddress" TEXT NOT NULL DEFAULT '',
    "umbraViewingKey" TEXT,
    "umbraSpendingKey" TEXT,
    "magicBlockSessionId" TEXT,
    "magicBlockValidatorEndpoint" TEXT,
    "privateExecutionEnabled" BOOLEAN NOT NULL DEFAULT false,
    "umbraShieldedMint" TEXT,
    "goldrushPortfolioSnapshot" JSONB,
    "goldrushStreamFilter" TEXT,
    "configuration" JSONB,
    "envConfig" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Agent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PrivateBrainConfig" (
    "id" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "ownerId" TEXT NOT NULL,
    "privateBrainEnabled" BOOLEAN NOT NULL DEFAULT false,
    "perValidator" TEXT NOT NULL,
    "perValidatorPubkey" TEXT NOT NULL,
    "memorySlots" INTEGER NOT NULL DEFAULT 8,
    "geofenceRegions" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "ofacCheckEnabled" BOOLEAN NOT NULL DEFAULT true,
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

-- CreateTable
CREATE TABLE "PrivateBrainAudit" (
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

-- CreateTable
CREATE TABLE "ShieldedExecutionConfig" (
    "id" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "ownerId" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "perValidator" TEXT NOT NULL,
    "perValidatorPubkey" TEXT NOT NULL,
    "shieldStrategyLogic" BOOLEAN NOT NULL DEFAULT true,
    "shieldIntent" BOOLEAN NOT NULL DEFAULT true,
    "shieldIntermediateStates" BOOLEAN NOT NULL DEFAULT true,
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

-- CreateTable
CREATE TABLE "ShieldedExecutionAudit" (
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

-- CreateTable
CREATE TABLE "BotWallet" (
    "id" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "ownerId" TEXT NOT NULL,
    "pubkey" TEXT NOT NULL,
    "encryptedKey" TEXT,
    "solBalanceLamports" BIGINT NOT NULL DEFAULT 0,
    "usdcBalanceMicro" BIGINT NOT NULL DEFAULT 0,
    "privatePaymentsEnabled" BOOLEAN NOT NULL DEFAULT false,
    "paymentApiKeyHash" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BotWallet_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BotService" (
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
    "isPublic" BOOLEAN NOT NULL DEFAULT false,
    "requiresWhitelist" BOOLEAN NOT NULL DEFAULT false,
    "status" TEXT NOT NULL DEFAULT 'offline',
    "lastHeartbeat" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BotService_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BotServiceWhitelist" (
    "id" TEXT NOT NULL,
    "serviceId" TEXT NOT NULL,
    "allowedAgentId" TEXT NOT NULL,
    "grantedBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BotServiceWhitelist_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "A2APaymentChannel" (
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

-- CreateTable
CREATE TABLE "A2APayment" (
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

-- CreateTable
CREATE TABLE "AgentFile" (
    "id" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "filepath" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "language" TEXT NOT NULL DEFAULT 'plaintext',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AgentFile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TradeLog" (
    "id" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "txHash" TEXT NOT NULL,
    "tokenIn" TEXT NOT NULL,
    "tokenOut" TEXT NOT NULL,
    "amountIn" TEXT NOT NULL,
    "amountOut" TEXT NOT NULL,
    "profitUsd" TEXT NOT NULL,
    "executionTimeMs" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TradeLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
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

-- CreateTable
CREATE TABLE "TerminalLog" (
    "id" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "line" TEXT NOT NULL,
    "level" TEXT NOT NULL,
    "timestamp" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TerminalLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE UNIQUE INDEX "PrivateBrainConfig_agentId_key" ON "PrivateBrainConfig"("agentId");

-- CreateIndex
CREATE INDEX "PrivateBrainConfig_ownerId_idx" ON "PrivateBrainConfig"("ownerId");

-- CreateIndex
CREATE INDEX "PrivateBrainConfig_status_idx" ON "PrivateBrainConfig"("status");

-- CreateIndex
CREATE INDEX "PrivateBrainAudit_agentId_idx" ON "PrivateBrainAudit"("agentId");

-- CreateIndex
CREATE INDEX "PrivateBrainAudit_configId_idx" ON "PrivateBrainAudit"("configId");

-- CreateIndex
CREATE INDEX "PrivateBrainAudit_actorId_idx" ON "PrivateBrainAudit"("actorId");

-- CreateIndex
CREATE UNIQUE INDEX "ShieldedExecutionConfig_agentId_key" ON "ShieldedExecutionConfig"("agentId");

-- CreateIndex
CREATE INDEX "ShieldedExecutionConfig_ownerId_idx" ON "ShieldedExecutionConfig"("ownerId");

-- CreateIndex
CREATE INDEX "ShieldedExecutionConfig_status_idx" ON "ShieldedExecutionConfig"("status");

-- CreateIndex
CREATE INDEX "ShieldedExecutionAudit_agentId_idx" ON "ShieldedExecutionAudit"("agentId");

-- CreateIndex
CREATE INDEX "ShieldedExecutionAudit_configId_idx" ON "ShieldedExecutionAudit"("configId");

-- CreateIndex
CREATE INDEX "ShieldedExecutionAudit_actorId_idx" ON "ShieldedExecutionAudit"("actorId");

-- CreateIndex
CREATE UNIQUE INDEX "BotWallet_agentId_key" ON "BotWallet"("agentId");

-- CreateIndex
CREATE UNIQUE INDEX "BotWallet_pubkey_key" ON "BotWallet"("pubkey");

-- CreateIndex
CREATE INDEX "BotWallet_ownerId_idx" ON "BotWallet"("ownerId");

-- CreateIndex
CREATE INDEX "BotService_agentId_idx" ON "BotService"("agentId");

-- CreateIndex
CREATE INDEX "BotService_ownerId_idx" ON "BotService"("ownerId");

-- CreateIndex
CREATE INDEX "BotService_status_idx" ON "BotService"("status");

-- CreateIndex
CREATE INDEX "BotService_serviceType_idx" ON "BotService"("serviceType");

-- CreateIndex
CREATE INDEX "BotServiceWhitelist_allowedAgentId_idx" ON "BotServiceWhitelist"("allowedAgentId");

-- CreateIndex
CREATE UNIQUE INDEX "BotServiceWhitelist_serviceId_allowedAgentId_key" ON "BotServiceWhitelist"("serviceId", "allowedAgentId");

-- CreateIndex
CREATE INDEX "A2APaymentChannel_serviceId_idx" ON "A2APaymentChannel"("serviceId");

-- CreateIndex
CREATE INDEX "A2APaymentChannel_status_idx" ON "A2APaymentChannel"("status");

-- CreateIndex
CREATE UNIQUE INDEX "A2APayment_idempotencyKey_key" ON "A2APayment"("idempotencyKey");

-- CreateIndex
CREATE INDEX "A2APayment_channelId_idx" ON "A2APayment"("channelId");

-- CreateIndex
CREATE INDEX "A2APayment_status_idx" ON "A2APayment"("status");

-- CreateIndex
CREATE UNIQUE INDEX "AgentFile_agentId_filepath_key" ON "AgentFile"("agentId", "filepath");

-- CreateIndex
CREATE UNIQUE INDEX "TradeLog_txHash_key" ON "TradeLog"("txHash");

-- CreateIndex
CREATE UNIQUE INDEX "Subscription_externalReference_key" ON "Subscription"("externalReference");

-- CreateIndex
CREATE INDEX "Subscription_agentId_provider_idx" ON "Subscription"("agentId", "provider");

-- CreateIndex
CREATE INDEX "Subscription_status_idx" ON "Subscription"("status");

-- CreateIndex
CREATE INDEX "Subscription_agentId_status_idx" ON "Subscription"("agentId", "status");

-- CreateIndex
CREATE INDEX "Subscription_provider_plan_idx" ON "Subscription"("provider", "plan");

-- AddForeignKey
ALTER TABLE "Agent" ADD CONSTRAINT "Agent_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PrivateBrainConfig" ADD CONSTRAINT "PrivateBrainConfig_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "Agent"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PrivateBrainConfig" ADD CONSTRAINT "PrivateBrainConfig_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PrivateBrainAudit" ADD CONSTRAINT "PrivateBrainAudit_configId_fkey" FOREIGN KEY ("configId") REFERENCES "PrivateBrainConfig"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PrivateBrainAudit" ADD CONSTRAINT "PrivateBrainAudit_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "Agent"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PrivateBrainAudit" ADD CONSTRAINT "PrivateBrainAudit_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ShieldedExecutionConfig" ADD CONSTRAINT "ShieldedExecutionConfig_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "Agent"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ShieldedExecutionConfig" ADD CONSTRAINT "ShieldedExecutionConfig_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ShieldedExecutionAudit" ADD CONSTRAINT "ShieldedExecutionAudit_configId_fkey" FOREIGN KEY ("configId") REFERENCES "ShieldedExecutionConfig"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ShieldedExecutionAudit" ADD CONSTRAINT "ShieldedExecutionAudit_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "Agent"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ShieldedExecutionAudit" ADD CONSTRAINT "ShieldedExecutionAudit_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BotWallet" ADD CONSTRAINT "BotWallet_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "Agent"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BotWallet" ADD CONSTRAINT "BotWallet_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BotService" ADD CONSTRAINT "BotService_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "Agent"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BotService" ADD CONSTRAINT "BotService_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BotServiceWhitelist" ADD CONSTRAINT "BotServiceWhitelist_serviceId_fkey" FOREIGN KEY ("serviceId") REFERENCES "BotService"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BotServiceWhitelist" ADD CONSTRAINT "BotServiceWhitelist_allowedAgentId_fkey" FOREIGN KEY ("allowedAgentId") REFERENCES "Agent"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "A2APaymentChannel" ADD CONSTRAINT "A2APaymentChannel_payerAgentId_fkey" FOREIGN KEY ("payerAgentId") REFERENCES "Agent"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "A2APaymentChannel" ADD CONSTRAINT "A2APaymentChannel_payeeAgentId_fkey" FOREIGN KEY ("payeeAgentId") REFERENCES "Agent"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "A2APaymentChannel" ADD CONSTRAINT "A2APaymentChannel_serviceId_fkey" FOREIGN KEY ("serviceId") REFERENCES "BotService"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "A2APayment" ADD CONSTRAINT "A2APayment_channelId_fkey" FOREIGN KEY ("channelId") REFERENCES "A2APaymentChannel"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "A2APayment" ADD CONSTRAINT "A2APayment_payerAgentId_fkey" FOREIGN KEY ("payerAgentId") REFERENCES "Agent"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "A2APayment" ADD CONSTRAINT "A2APayment_payeeAgentId_fkey" FOREIGN KEY ("payeeAgentId") REFERENCES "Agent"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentFile" ADD CONSTRAINT "AgentFile_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "Agent"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TradeLog" ADD CONSTRAINT "TradeLog_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "Agent"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Subscription" ADD CONSTRAINT "Subscription_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "Agent"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TerminalLog" ADD CONSTRAINT "TerminalLog_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "Agent"("id") ON DELETE CASCADE ON UPDATE CASCADE;
