CREATE TABLE "EngagementSuggestion" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "personaRevisionId" TEXT NOT NULL,
    "network" "SocialNetwork" NOT NULL,
    "targetUrl" TEXT NOT NULL,
    "targetAuthorHandleHash" TEXT,
    "sourceSnapshotHash" TEXT NOT NULL,
    "threadContextRef" JSONB,
    "voiceMode" TEXT NOT NULL,
    "intent" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "claimTrace" JSONB,
    "memoryTrace" JSONB,
    "judgeScores" JSONB,
    "policyMode" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PROPOSED',
    "version" INTEGER NOT NULL DEFAULT 1,
    "reviewedBy" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "executedInteractionId" TEXT,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "EngagementSuggestion_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "EngagementSuggestion" ADD CONSTRAINT "EngagementSuggestion_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "SocialAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "EngagementSuggestion" ADD CONSTRAINT "EngagementSuggestion_personaRevisionId_fkey" FOREIGN KEY ("personaRevisionId") REFERENCES "PersonaRevision"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "Interaction" ADD COLUMN "personaRevisionId" TEXT;
ALTER TABLE "Interaction" ADD COLUMN "voiceMode" TEXT;
ALTER TABLE "Interaction" ADD COLUMN "intent" TEXT;
ALTER TABLE "Interaction" ADD COLUMN "policyMode" TEXT;
ALTER TABLE "Interaction" ADD COLUMN "suggestionId" TEXT;
ALTER TABLE "Interaction" ADD CONSTRAINT "Interaction_suggestionId_fkey" FOREIGN KEY ("suggestionId") REFERENCES "EngagementSuggestion"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "EngagementSuggestion_accountId_status_createdAt_idx" ON "EngagementSuggestion"("accountId", "status", "createdAt");
CREATE INDEX "EngagementSuggestion_personaRevisionId_createdAt_idx" ON "EngagementSuggestion"("personaRevisionId", "createdAt");
CREATE INDEX "EngagementSuggestion_network_status_idx" ON "EngagementSuggestion"("network", "status");
CREATE UNIQUE INDEX "Interaction_suggestionId_key" ON "Interaction"("suggestionId");
