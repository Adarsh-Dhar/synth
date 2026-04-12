-- CreateEnum
CREATE TYPE "AgentStatus" AS ENUM ('RUNNING', 'PAUSED', 'REVOKED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "StrategyType" AS ENUM ('MEME_SNIPER', 'ARBITRAGE', 'SENTIMENT_TRADER');

-- CreateEnum
CREATE TYPE "LogType" AS ENUM ('INFO', 'EXECUTION_BUY', 'EXECUTION_SELL', 'PROFIT_SECURED', 'ERROR');

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "email" TEXT,
    "walletAddress" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Agent" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "strategy" "StrategyType" NOT NULL,
    "status" "AgentStatus" NOT NULL DEFAULT 'RUNNING',
    "targetPair" TEXT NOT NULL,
    "spendAllowance" DOUBLE PRECISION NOT NULL,
    "sessionExpiresAt" TIMESTAMP(3) NOT NULL,
    "sessionKeyPub" TEXT,
    "currentPnl" DOUBLE PRECISION NOT NULL DEFAULT 0.0,
    "userId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Agent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TradeLog" (
    "id" TEXT NOT NULL,
    "type" "LogType" NOT NULL,
    "message" TEXT NOT NULL,
    "txHash" TEXT,
    "price" DOUBLE PRECISION,
    "amount" DOUBLE PRECISION,
    "agentId" TEXT NOT NULL,
    "timestamp" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TradeLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE UNIQUE INDEX "User_walletAddress_key" ON "User"("walletAddress");

-- AddForeignKey
ALTER TABLE "Agent" ADD CONSTRAINT "Agent_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TradeLog" ADD CONSTRAINT "TradeLog_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "Agent"("id") ON DELETE CASCADE ON UPDATE CASCADE;
