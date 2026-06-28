-- CreateTable
CREATE TABLE "PostMetrics" (
    "id" TEXT NOT NULL,
    "postId" TEXT NOT NULL,
    "network" "SocialNetwork" NOT NULL,
    "likes" INTEGER NOT NULL DEFAULT 0,
    "comments" INTEGER NOT NULL DEFAULT 0,
    "shares" INTEGER NOT NULL DEFAULT 0,
    "impressions" INTEGER,
    "collectedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PostMetrics_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PostMetrics_postId_collectedAt_idx" ON "PostMetrics"("postId", "collectedAt");

-- CreateIndex
CREATE INDEX "PostMetrics_network_idx" ON "PostMetrics"("network");
