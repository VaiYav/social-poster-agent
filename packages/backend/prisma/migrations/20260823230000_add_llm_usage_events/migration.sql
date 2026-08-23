-- COST-001: durable secret-free provider-attempt accounting.
CREATE TABLE "LlmUsageEvent" (
    "id" TEXT NOT NULL,
    "accountId" TEXT,
    "postId" TEXT,
    "runId" TEXT,
    "provider" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "tokensIn" INTEGER NOT NULL DEFAULT 0,
    "tokensOut" INTEGER NOT NULL DEFAULT 0,
    "costUsd" DECIMAL(10,6) NOT NULL,
    "cached" BOOLEAN NOT NULL DEFAULT false,
    "durationMs" INTEGER,
    "outcome" TEXT NOT NULL,
    "costSource" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LlmUsageEvent_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "LlmUsageEvent_accountId_createdAt_idx" ON "LlmUsageEvent"("accountId", "createdAt");
CREATE INDEX "LlmUsageEvent_runId_idx" ON "LlmUsageEvent"("runId");
CREATE INDEX "LlmUsageEvent_role_createdAt_idx" ON "LlmUsageEvent"("role", "createdAt");
