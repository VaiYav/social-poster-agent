CREATE TABLE "EditorialOpportunity" (
    "id" TEXT NOT NULL,
    "sourceType" TEXT NOT NULL,
    "sourceRef" JSONB NOT NULL,
    "domain" TEXT NOT NULL,
    "canonicalTopic" TEXT NOT NULL,
    "thesisHash" TEXT NOT NULL,
    "riskTier" TEXT NOT NULL,
    "funnelIntent" TEXT NOT NULL,
    "validFrom" TIMESTAMP(3),
    "validUntil" TIMESTAMP(3),
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "EditorialOpportunity_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "EditorialAssignmentRecord" (
    "id" TEXT NOT NULL,
    "opportunityId" TEXT NOT NULL,
    "accountId" TEXT,
    "personaRevisionId" TEXT,
    "action" TEXT NOT NULL,
    "thesis" TEXT NOT NULL,
    "thesisHash" TEXT NOT NULL,
    "angle" TEXT NOT NULL,
    "voiceMode" TEXT,
    "funnelIntent" TEXT NOT NULL,
    "scoreComponents" JSONB NOT NULL,
    "constraintResults" JSONB NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PLANNED',
    "experimentAssignmentId" TEXT,
    "validUntil" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "EditorialAssignmentRecord_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "EditorialAssignmentRecord" ADD CONSTRAINT "EditorialAssignmentRecord_opportunityId_fkey" FOREIGN KEY ("opportunityId") REFERENCES "EditorialOpportunity"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "EditorialAssignmentRecord" ADD CONSTRAINT "EditorialAssignmentRecord_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "SocialAccount"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "EditorialAssignmentRecord" ADD CONSTRAINT "EditorialAssignmentRecord_personaRevisionId_fkey" FOREIGN KEY ("personaRevisionId") REFERENCES "PersonaRevision"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "EditorialOpportunity_status_validUntil_idx" ON "EditorialOpportunity"("status", "validUntil");
CREATE INDEX "EditorialOpportunity_domain_createdAt_idx" ON "EditorialOpportunity"("domain", "createdAt");
CREATE INDEX "EditorialOpportunity_thesisHash_idx" ON "EditorialOpportunity"("thesisHash");
CREATE INDEX "EditorialAssignmentRecord_accountId_status_createdAt_idx" ON "EditorialAssignmentRecord"("accountId", "status", "createdAt");
CREATE INDEX "EditorialAssignmentRecord_personaRevisionId_createdAt_idx" ON "EditorialAssignmentRecord"("personaRevisionId", "createdAt");
CREATE INDEX "EditorialAssignmentRecord_thesisHash_createdAt_idx" ON "EditorialAssignmentRecord"("thesisHash", "createdAt");
