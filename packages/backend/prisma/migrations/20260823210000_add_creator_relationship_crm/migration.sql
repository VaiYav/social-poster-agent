CREATE TABLE "CreatorProfile" (
    "id" TEXT NOT NULL,
    "network" "SocialNetwork" NOT NULL,
    "handleCanonical" TEXT NOT NULL,
    "handleHash" TEXT NOT NULL,
    "displayName" TEXT,
    "profileUrl" TEXT NOT NULL,
    "publicTopics" JSONB NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "sourceRefs" JSONB NOT NULL,
    "lastVerifiedAt" TIMESTAMP(3),
    "rawProfileExpiresAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "CreatorProfile_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "CreatorRelationship" (
    "id" TEXT NOT NULL,
    "creatorId" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "personaRevisionId" TEXT,
    "stage" TEXT NOT NULL DEFAULT 'DISCOVERED',
    "stageEvidence" JSONB NOT NULL,
    "sharedDomains" JSONB NOT NULL,
    "interactionCount" INTEGER NOT NULL DEFAULT 0,
    "substantiveReplyCount" INTEGER NOT NULL DEFAULT 0,
    "reciprocalCount" INTEGER NOT NULL DEFAULT 0,
    "lastInteractionAt" TIMESTAMP(3),
    "cooldownUntil" TIMESTAMP(3),
    "ownerNote" TEXT,
    "manualPriority" TEXT,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "CreatorRelationship_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "CreatorInteractionEvidence" (
    "id" TEXT NOT NULL,
    "relationshipId" TEXT NOT NULL,
    "interactionId" TEXT,
    "evidenceType" TEXT NOT NULL,
    "sourceRef" JSONB NOT NULL,
    "evidenceHash" TEXT NOT NULL,
    "weight" DOUBLE PRECISION,
    "occurredAt" TIMESTAMP(3) NOT NULL,
    "expiresAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "CreatorInteractionEvidence_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "CollaborationOpportunity" (
    "id" TEXT NOT NULL,
    "relationshipId" TEXT NOT NULL,
    "opportunityType" TEXT NOT NULL,
    "topic" TEXT NOT NULL,
    "rationale" JSONB NOT NULL,
    "risks" JSONB NOT NULL,
    "proposedAccountId" TEXT NOT NULL,
    "proposedPersonaId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'PROPOSED',
    "version" INTEGER NOT NULL DEFAULT 1,
    "reviewedBy" TEXT,
    "outreachRef" JSONB,
    "campaignRef" JSONB,
    "validUntil" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "CollaborationOpportunity_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "CreatorRelationship" ADD CONSTRAINT "CreatorRelationship_creatorId_fkey" FOREIGN KEY ("creatorId") REFERENCES "CreatorProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CreatorRelationship" ADD CONSTRAINT "CreatorRelationship_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "SocialAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CreatorRelationship" ADD CONSTRAINT "CreatorRelationship_personaRevisionId_fkey" FOREIGN KEY ("personaRevisionId") REFERENCES "PersonaRevision"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "CreatorInteractionEvidence" ADD CONSTRAINT "CreatorInteractionEvidence_relationshipId_fkey" FOREIGN KEY ("relationshipId") REFERENCES "CreatorRelationship"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CollaborationOpportunity" ADD CONSTRAINT "CollaborationOpportunity_relationshipId_fkey" FOREIGN KEY ("relationshipId") REFERENCES "CreatorRelationship"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE UNIQUE INDEX "CreatorProfile_network_handleCanonical_key" ON "CreatorProfile"("network", "handleCanonical");
CREATE INDEX "CreatorProfile_network_status_idx" ON "CreatorProfile"("network", "status");
CREATE INDEX "CreatorProfile_handleHash_idx" ON "CreatorProfile"("handleHash");
CREATE UNIQUE INDEX "CreatorRelationship_creatorId_accountId_key" ON "CreatorRelationship"("creatorId", "accountId");
CREATE INDEX "CreatorRelationship_accountId_stage_status_idx" ON "CreatorRelationship"("accountId", "stage", "status");
CREATE INDEX "CreatorRelationship_personaRevisionId_lastInteractionAt_idx" ON "CreatorRelationship"("personaRevisionId", "lastInteractionAt");
CREATE UNIQUE INDEX "CreatorInteractionEvidence_relationshipId_evidenceType_evidenceHash_key" ON "CreatorInteractionEvidence"("relationshipId", "evidenceType", "evidenceHash");
CREATE INDEX "CreatorInteractionEvidence_relationshipId_occurredAt_idx" ON "CreatorInteractionEvidence"("relationshipId", "occurredAt");
CREATE INDEX "CollaborationOpportunity_status_validUntil_idx" ON "CollaborationOpportunity"("status", "validUntil");
CREATE INDEX "CollaborationOpportunity_proposedAccountId_createdAt_idx" ON "CollaborationOpportunity"("proposedAccountId", "createdAt");
