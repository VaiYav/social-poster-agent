CREATE TABLE "PersonaMemory" (
    "id" TEXT NOT NULL,
    "personaId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "sourceType" TEXT NOT NULL,
    "sourceRef" JSONB,
    "status" TEXT NOT NULL DEFAULT 'CANDIDATE',
    "reviewedBy" TEXT,
    "confidence" DOUBLE PRECISION,
    "importance" DOUBLE PRECISION NOT NULL DEFAULT 0.5,
    "occurredAt" TIMESTAMP(3),
    "validFrom" TIMESTAMP(3),
    "validTo" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3),
    "contentHash" TEXT NOT NULL,
    "embeddingModel" TEXT,
    "lastUsedAt" TIMESTAMP(3),
    "usageCount" INTEGER NOT NULL DEFAULT 0,
    "supersededById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "PersonaMemory_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "KnowledgeEvidence" (
    "id" TEXT NOT NULL,
    "domain" TEXT NOT NULL,
    "riskClass" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "sourceUrl" TEXT,
    "sourceType" TEXT NOT NULL,
    "reviewStatus" TEXT NOT NULL DEFAULT 'NEEDS_REVIEW',
    "reviewedBy" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "validFrom" TIMESTAMP(3),
    "validTo" TIMESTAMP(3),
    "contentHash" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "KnowledgeEvidence_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "PersonaMemory" ADD CONSTRAINT "PersonaMemory_personaId_fkey" FOREIGN KEY ("personaId") REFERENCES "EditorialPersona"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE UNIQUE INDEX "PersonaMemory_personaId_kind_contentHash_key" ON "PersonaMemory"("personaId", "kind", "contentHash");
CREATE INDEX "PersonaMemory_personaId_status_kind_idx" ON "PersonaMemory"("personaId", "status", "kind");
CREATE INDEX "PersonaMemory_expiresAt_idx" ON "PersonaMemory"("expiresAt");
CREATE UNIQUE INDEX "KnowledgeEvidence_contentHash_key" ON "KnowledgeEvidence"("contentHash");
CREATE INDEX "KnowledgeEvidence_domain_reviewStatus_idx" ON "KnowledgeEvidence"("domain", "reviewStatus");
CREATE INDEX "KnowledgeEvidence_validTo_idx" ON "KnowledgeEvidence"("validTo");
