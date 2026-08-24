CREATE TABLE "AudienceSignal" (
    "id" TEXT NOT NULL,
    "sourceType" TEXT NOT NULL,
    "sourceRef" JSONB NOT NULL,
    "network" "SocialNetwork" NOT NULL,
    "accountId" TEXT,
    "personaRevisionId" TEXT,
    "signalType" TEXT NOT NULL,
    "domain" TEXT NOT NULL,
    "normalizedQuestion" TEXT NOT NULL,
    "languagePattern" TEXT,
    "extractedClaims" JSONB,
    "riskTier" TEXT NOT NULL,
    "privacyStatus" TEXT NOT NULL DEFAULT 'ELIGIBLE',
    "sourceAuthorHash" TEXT,
    "sourceSnapshotHash" TEXT NOT NULL,
    "occurredAt" TIMESTAMP(3) NOT NULL,
    "expiresAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AudienceSignal_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "AudienceQuestionCluster" (
    "id" TEXT NOT NULL,
    "clusterKey" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "canonicalQuestion" TEXT NOT NULL,
    "domain" TEXT NOT NULL,
    "signalTypes" JSONB NOT NULL,
    "riskTier" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'NEW',
    "sourceCount" INTEGER NOT NULL DEFAULT 0,
    "distinctAuthorCount" INTEGER NOT NULL DEFAULT 0,
    "firstSeenAt" TIMESTAMP(3) NOT NULL,
    "lastSeenAt" TIMESTAMP(3) NOT NULL,
    "demandScore" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "scoreComponents" JSONB NOT NULL,
    "answerState" JSONB,
    "linkedTopicId" TEXT,
    "reviewedBy" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "AudienceQuestionCluster_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "AudienceClusterMembership" (
    "clusterId" TEXT NOT NULL,
    "signalId" TEXT NOT NULL,
    "similarity" DOUBLE PRECISION,
    "method" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AudienceClusterMembership_pkey" PRIMARY KEY ("clusterId", "signalId")
);

CREATE TABLE "ProductInsightProposal" (
    "id" TEXT NOT NULL,
    "clusterId" TEXT NOT NULL,
    "insightType" TEXT NOT NULL,
    "summary" TEXT NOT NULL,
    "evidence" JSONB NOT NULL,
    "privacyReview" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "destinationRef" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "ProductInsightProposal_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "AudienceClusterMembership" ADD CONSTRAINT "AudienceClusterMembership_clusterId_fkey" FOREIGN KEY ("clusterId") REFERENCES "AudienceQuestionCluster"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AudienceClusterMembership" ADD CONSTRAINT "AudienceClusterMembership_signalId_fkey" FOREIGN KEY ("signalId") REFERENCES "AudienceSignal"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ProductInsightProposal" ADD CONSTRAINT "ProductInsightProposal_clusterId_fkey" FOREIGN KEY ("clusterId") REFERENCES "AudienceQuestionCluster"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE UNIQUE INDEX "AudienceSignal_network_sourceSnapshotHash_signalType_key" ON "AudienceSignal"("network", "sourceSnapshotHash", "signalType");
CREATE INDEX "AudienceSignal_domain_signalType_occurredAt_idx" ON "AudienceSignal"("domain", "signalType", "occurredAt");
CREATE INDEX "AudienceSignal_privacyStatus_expiresAt_idx" ON "AudienceSignal"("privacyStatus", "expiresAt");
CREATE UNIQUE INDEX "AudienceQuestionCluster_clusterKey_key" ON "AudienceQuestionCluster"("clusterKey");
CREATE INDEX "AudienceQuestionCluster_status_demandScore_idx" ON "AudienceQuestionCluster"("status", "demandScore");
CREATE INDEX "AudienceQuestionCluster_domain_lastSeenAt_idx" ON "AudienceQuestionCluster"("domain", "lastSeenAt");
CREATE INDEX "AudienceClusterMembership_signalId_idx" ON "AudienceClusterMembership"("signalId");
CREATE INDEX "ProductInsightProposal_status_createdAt_idx" ON "ProductInsightProposal"("status", "createdAt");
CREATE INDEX "ProductInsightProposal_clusterId_idx" ON "ProductInsightProposal"("clusterId");
