CREATE TABLE "PlatformPolicyEvidence" (
    "id" TEXT NOT NULL,
    "network" "SocialNetwork" NOT NULL,
    "sourceUrl" TEXT NOT NULL,
    "sourceType" TEXT NOT NULL,
    "contentHash" TEXT NOT NULL,
    "snapshotRef" TEXT,
    "fetchedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "verifiedAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3),
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "reviewer" TEXT,
    "reviewNotes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "PlatformPolicyEvidence_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "PlatformActionPolicy" (
    "id" TEXT NOT NULL,
    "policyKey" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "network" "SocialNetwork" NOT NULL,
    "action" TEXT NOT NULL,
    "transport" TEXT NOT NULL,
    "targetRelationship" TEXT NOT NULL,
    "executionMode" TEXT NOT NULL,
    "requirements" JSONB NOT NULL,
    "limits" JSONB,
    "evidenceId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "effectiveAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3),
    "approvedBy" TEXT,
    "approvedAt" TIMESTAMP(3),
    "supersedesId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "PlatformActionPolicy_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "CompiledExecutionPolicy" (
    "id" TEXT NOT NULL,
    "accountId" TEXT,
    "network" "SocialNetwork" NOT NULL,
    "action" TEXT NOT NULL,
    "contextClass" TEXT NOT NULL,
    "executionMode" TEXT NOT NULL,
    "sourcePolicyIds" JSONB NOT NULL,
    "reputationState" TEXT NOT NULL,
    "policyHash" TEXT NOT NULL,
    "validUntil" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "CompiledExecutionPolicy_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "PlatformPolicyEvidence_sourceUrl_contentHash_key" ON "PlatformPolicyEvidence"("sourceUrl", "contentHash");
CREATE INDEX "PlatformPolicyEvidence_network_status_expiresAt_idx" ON "PlatformPolicyEvidence"("network", "status", "expiresAt");
CREATE UNIQUE INDEX "PlatformActionPolicy_policyKey_version_key" ON "PlatformActionPolicy"("policyKey", "version");
CREATE INDEX "PlatformActionPolicy_network_action_status_idx" ON "PlatformActionPolicy"("network", "action", "status");
CREATE INDEX "PlatformActionPolicy_expiresAt_idx" ON "PlatformActionPolicy"("expiresAt");
CREATE UNIQUE INDEX "CompiledExecutionPolicy_accountId_network_action_contextClass_policyHash_key" ON "CompiledExecutionPolicy"("accountId", "network", "action", "contextClass", "policyHash");
CREATE INDEX "CompiledExecutionPolicy_accountId_network_action_idx" ON "CompiledExecutionPolicy"("accountId", "network", "action");

ALTER TABLE "PlatformActionPolicy" ADD CONSTRAINT "PlatformActionPolicy_evidenceId_fkey" FOREIGN KEY ("evidenceId") REFERENCES "PlatformPolicyEvidence"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "CompiledExecutionPolicy" ADD CONSTRAINT "CompiledExecutionPolicy_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "SocialAccount"("id") ON DELETE SET NULL ON UPDATE CASCADE;
