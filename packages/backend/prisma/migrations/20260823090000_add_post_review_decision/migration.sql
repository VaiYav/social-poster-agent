-- EVAL-501: durable human review truth.
-- Additive only: historical Post.status values are not converted into reviews.

CREATE TABLE "PostReviewDecision" (
    "id" TEXT NOT NULL,
    "postId" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "actorId" TEXT,
    "decision" TEXT NOT NULL,
    "reasonCodes" JSONB NOT NULL,
    "rubric" JSONB,
    "comment" TEXT,
    "originalContentHash" TEXT NOT NULL,
    "finalContentHash" TEXT,
    "normalizedEditDistance" DOUBLE PRECISION,
    "generationRunId" TEXT,
    "langfuseTraceId" TEXT,
    "langfuseObservationId" TEXT,
    "syncStatus" TEXT NOT NULL DEFAULT 'PENDING',
    "syncAttempts" INTEGER NOT NULL DEFAULT 0,
    "lastSyncError" TEXT,
    "langfuseSyncedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PostReviewDecision_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "PostReviewDecision_postId_version_key"
    ON "PostReviewDecision"("postId", "version");
CREATE INDEX "PostReviewDecision_decision_createdAt_idx"
    ON "PostReviewDecision"("decision", "createdAt");
CREATE INDEX "PostReviewDecision_syncStatus_createdAt_idx"
    ON "PostReviewDecision"("syncStatus", "createdAt");
CREATE INDEX "PostReviewDecision_langfuseTraceId_idx"
    ON "PostReviewDecision"("langfuseTraceId");

ALTER TABLE "PostReviewDecision"
    ADD CONSTRAINT "PostReviewDecision_postId_fkey"
    FOREIGN KEY ("postId") REFERENCES "Post"("id") ON DELETE CASCADE ON UPDATE CASCADE;
