-- CreateEnum
CREATE TYPE "CommentStatus" AS ENUM ('NEW', 'REPLIED', 'SKIPPED', 'HUMAN_REVIEW', 'REPLIED_MANUAL');

-- CreateTable
CREATE TABLE "IncomingComment" (
    "id" TEXT NOT NULL,
    "postId" TEXT NOT NULL,
    "network" "SocialNetwork" NOT NULL,
    "commentId" TEXT NOT NULL,
    "author" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "authorProfileUrl" TEXT,
    "status" "CommentStatus" NOT NULL DEFAULT 'NEW',
    "replyText" TEXT,
    "replyPostedAt" TIMESTAMP(3),
    "needsHumanReview" BOOLEAN NOT NULL DEFAULT false,
    "humanReviewReason" TEXT,
    "scrapedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "IncomingComment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "IncomingComment_postId_idx" ON "IncomingComment"("postId");

-- CreateIndex
CREATE INDEX "IncomingComment_status_idx" ON "IncomingComment"("status");

-- CreateIndex
CREATE INDEX "IncomingComment_network_idx" ON "IncomingComment"("network");

-- CreateIndex
CREATE INDEX "IncomingComment_scrapedAt_idx" ON "IncomingComment"("scrapedAt");

-- CreateIndex
CREATE UNIQUE INDEX "IncomingComment_postId_commentId_key" ON "IncomingComment"("postId", "commentId");

-- AddForeignKey
ALTER TABLE "PostMetrics" ADD CONSTRAINT "PostMetrics_postId_fkey" FOREIGN KEY ("postId") REFERENCES "Post"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IncomingComment" ADD CONSTRAINT "IncomingComment_postId_fkey" FOREIGN KEY ("postId") REFERENCES "Post"("id") ON DELETE CASCADE ON UPDATE CASCADE;
