-- CreateTable
CREATE TABLE "TerminalLog" (
    "id" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "line" TEXT NOT NULL,
    "level" TEXT NOT NULL,
    "timestamp" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TerminalLog_pkey" PRIMARY KEY ("id")
);

-- AddForeignKey
ALTER TABLE "TerminalLog" ADD CONSTRAINT "TerminalLog_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "Agent"("id") ON DELETE CASCADE ON UPDATE CASCADE;
