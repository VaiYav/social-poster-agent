CREATE TABLE "AccountReputationState" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "network" "SocialNetwork" NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'HEALTHY',
    "version" INTEGER NOT NULL DEFAULT 1,
    "reason" TEXT,
    "changedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "AccountReputationState_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ReputationSignal" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "network" "SocialNetwork" NOT NULL,
    "signalType" TEXT NOT NULL,
    "signalFamily" TEXT NOT NULL,
    "severity" TEXT NOT NULL,
    "trustLevel" TEXT NOT NULL,
    "sourceRef" JSONB NOT NULL,
    "evidenceHash" TEXT NOT NULL,
    "classification" JSONB,
    "occurredAt" TIMESTAMP(3) NOT NULL,
    "expiresAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ReputationSignal_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ReputationIncident" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "network" "SocialNetwork" NOT NULL,
    "status" TEXT NOT NULL,
    "stateBefore" TEXT NOT NULL,
    "stateAfter" TEXT NOT NULL,
    "severity" TEXT NOT NULL,
    "signalIds" JSONB NOT NULL,
    "decisionRules" JSONB NOT NULL,
    "automaticActions" JSONB NOT NULL,
    "operatorActions" JSONB,
    "owner" TEXT,
    "acknowledgedAt" TIMESTAMP(3),
    "resolvedAt" TIMESTAMP(3),
    "recoveryPlan" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "ReputationIncident_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "AccountReputationState" ADD CONSTRAINT "AccountReputationState_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "SocialAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ReputationSignal" ADD CONSTRAINT "ReputationSignal_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "SocialAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ReputationIncident" ADD CONSTRAINT "ReputationIncident_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "SocialAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE UNIQUE INDEX "AccountReputationState_accountId_network_key" ON "AccountReputationState"("accountId", "network");
CREATE INDEX "AccountReputationState_state_updatedAt_idx" ON "AccountReputationState"("state", "updatedAt");
CREATE UNIQUE INDEX "ReputationSignal_accountId_network_signalType_evidenceHash_key" ON "ReputationSignal"("accountId", "network", "signalType", "evidenceHash");
CREATE INDEX "ReputationSignal_accountId_network_occurredAt_idx" ON "ReputationSignal"("accountId", "network", "occurredAt");
CREATE INDEX "ReputationSignal_signalFamily_severity_idx" ON "ReputationSignal"("signalFamily", "severity");
CREATE INDEX "ReputationIncident_accountId_network_status_idx" ON "ReputationIncident"("accountId", "network", "status");
CREATE INDEX "ReputationIncident_severity_createdAt_idx" ON "ReputationIncident"("severity", "createdAt");
