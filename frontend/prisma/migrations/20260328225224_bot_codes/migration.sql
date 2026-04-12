/*
  Warnings:

  - The values [PAUSED,REVOKED,EXPIRED] on the enum `AgentStatus` will be removed. If these variants are still used in the database, this will fail.
  - You are about to drop the column `currentPnl` on the `Agent` table. All the data in the column will be lost.
  - You are about to drop the column `sessionExpiresAt` on the `Agent` table. All the data in the column will be lost.
  - You are about to drop the column `sessionKeyPub` on the `Agent` table. All the data in the column will be lost.
  - You are about to drop the column `spendAllowance` on the `Agent` table. All the data in the column will be lost.
  - You are about to drop the column `strategy` on the `Agent` table. All the data in the column will be lost.
  - You are about to drop the column `targetPair` on the `Agent` table. All the data in the column will be lost.
  - You are about to drop the column `amount` on the `TradeLog` table. All the data in the column will be lost.
  - You are about to drop the column `message` on the `TradeLog` table. All the data in the column will be lost.
  - You are about to drop the column `price` on the `TradeLog` table. All the data in the column will be lost.
  - You are about to drop the column `timestamp` on the `TradeLog` table. All the data in the column will be lost.
  - You are about to drop the column `type` on the `TradeLog` table. All the data in the column will be lost.
  - You are about to drop the column `walletAddress` on the `User` table. All the data in the column will be lost.
  - A unique constraint covering the columns `[txHash]` on the table `TradeLog` will be added. If there are existing duplicate values, this will fail.
  - Added the required column `amountIn` to the `TradeLog` table without a default value. This is not possible if the table is not empty.
  - Added the required column `amountOut` to the `TradeLog` table without a default value. This is not possible if the table is not empty.
  - Added the required column `executionTimeMs` to the `TradeLog` table without a default value. This is not possible if the table is not empty.
  - Added the required column `profitEth` to the `TradeLog` table without a default value. This is not possible if the table is not empty.
  - Added the required column `profitUsd` to the `TradeLog` table without a default value. This is not possible if the table is not empty.
  - Added the required column `tokenIn` to the `TradeLog` table without a default value. This is not possible if the table is not empty.
  - Added the required column `tokenOut` to the `TradeLog` table without a default value. This is not possible if the table is not empty.
  - Made the column `txHash` on table `TradeLog` required. This step will fail if there are existing NULL values in that column.
  - Made the column `email` on table `User` required. This step will fail if there are existing NULL values in that column.

*/
-- AlterEnum
BEGIN;
CREATE TYPE "AgentStatus_new" AS ENUM ('STARTING', 'RUNNING', 'STOPPING', 'STOPPED', 'ERROR');
ALTER TABLE "public"."Agent" ALTER COLUMN "status" DROP DEFAULT;
ALTER TABLE "Agent" ALTER COLUMN "status" TYPE "AgentStatus_new" USING ("status"::text::"AgentStatus_new");
ALTER TYPE "AgentStatus" RENAME TO "AgentStatus_old";
ALTER TYPE "AgentStatus_new" RENAME TO "AgentStatus";
DROP TYPE "public"."AgentStatus_old";
ALTER TABLE "Agent" ALTER COLUMN "status" SET DEFAULT 'STOPPED';
COMMIT;

-- DropIndex
DROP INDEX "User_walletAddress_key";

-- AlterTable
ALTER TABLE "Agent" DROP COLUMN "currentPnl",
DROP COLUMN "sessionExpiresAt",
DROP COLUMN "sessionKeyPub",
DROP COLUMN "spendAllowance",
DROP COLUMN "strategy",
DROP COLUMN "targetPair",
ADD COLUMN     "configuration" JSONB,
ALTER COLUMN "status" SET DEFAULT 'STOPPED';

-- AlterTable
ALTER TABLE "TradeLog" DROP COLUMN "amount",
DROP COLUMN "message",
DROP COLUMN "price",
DROP COLUMN "timestamp",
DROP COLUMN "type",
ADD COLUMN     "amountIn" TEXT NOT NULL,
ADD COLUMN     "amountOut" TEXT NOT NULL,
ADD COLUMN     "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN     "executionTimeMs" INTEGER NOT NULL,
ADD COLUMN     "profitEth" TEXT NOT NULL,
ADD COLUMN     "profitUsd" TEXT NOT NULL,
ADD COLUMN     "tokenIn" TEXT NOT NULL,
ADD COLUMN     "tokenOut" TEXT NOT NULL,
ALTER COLUMN "txHash" SET NOT NULL;

-- AlterTable
ALTER TABLE "User" DROP COLUMN "walletAddress",
ADD COLUMN     "name" TEXT,
ALTER COLUMN "email" SET NOT NULL;

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

-- CreateIndex
CREATE UNIQUE INDEX "AgentFile_agentId_filepath_key" ON "AgentFile"("agentId", "filepath");

-- CreateIndex
CREATE UNIQUE INDEX "TradeLog_txHash_key" ON "TradeLog"("txHash");

-- AddForeignKey
ALTER TABLE "AgentFile" ADD CONSTRAINT "AgentFile_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "Agent"("id") ON DELETE CASCADE ON UPDATE CASCADE;
