-- CreateTable
CREATE TABLE "PostVariant" (
    "id" TEXT NOT NULL,
    "postId" TEXT NOT NULL,
    "network" "SocialNetwork" NOT NULL,
    "label" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "judgeScores" JSONB,
    "selected" BOOLEAN NOT NULL DEFAULT false,
    "postedAt" TIMESTAMP(3),
    "metricsAt" TIMESTAMP(3),
    "likes" INTEGER,
    "comments" INTEGER,
    "shares" INTEGER,
    "impressions" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PostVariant_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PostVariant_postId_idx" ON "PostVariant"("postId");

-- CreateIndex
CREATE INDEX "PostVariant_network_idx" ON "PostVariant"("network");

-- AddForeignKey
ALTER TABLE "PostVariant" ADD CONSTRAINT "PostVariant_postId_fkey" FOREIGN KEY ("postId") REFERENCES "Post"("id") ON DELETE CASCADE ON UPDATE CASCADE;
