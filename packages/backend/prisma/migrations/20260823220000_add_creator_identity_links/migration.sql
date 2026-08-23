-- CRM-101: cross-network identity links are explicit operator decisions.
CREATE TABLE "CreatorIdentityLink" (
    "id" TEXT NOT NULL,
    "sourceCreatorId" TEXT NOT NULL,
    "targetCreatorId" TEXT NOT NULL,
    "evidence" JSONB NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'REVIEWED',
    "reviewedBy" TEXT NOT NULL,
    "reviewedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reviewReason" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CreatorIdentityLink_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "CreatorIdentityLink" ADD CONSTRAINT "CreatorIdentityLink_sourceCreatorId_fkey"
    FOREIGN KEY ("sourceCreatorId") REFERENCES "CreatorProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CreatorIdentityLink" ADD CONSTRAINT "CreatorIdentityLink_targetCreatorId_fkey"
    FOREIGN KEY ("targetCreatorId") REFERENCES "CreatorProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE UNIQUE INDEX "CreatorIdentityLink_sourceCreatorId_targetCreatorId_key"
    ON "CreatorIdentityLink"("sourceCreatorId", "targetCreatorId");
CREATE INDEX "CreatorIdentityLink_sourceCreatorId_status_idx"
    ON "CreatorIdentityLink"("sourceCreatorId", "status");
CREATE INDEX "CreatorIdentityLink_targetCreatorId_status_idx"
    ON "CreatorIdentityLink"("targetCreatorId", "status");
