-- CreateTable
-- P0-H2: ThreadProgress — per-reply tracking for resumable threads.
-- If the process crashes mid-thread, this table records which replies were
-- already posted so the resume logic can skip them.
CREATE TABLE "ThreadProgress" (
    "id" TEXT NOT NULL,
    "postId" TEXT NOT NULL,
    "replyPostId" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "status" TEXT NOT NULL,
    "postUrl" TEXT,
    "attemptedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),
    "error" TEXT,

    CONSTRAINT "ThreadProgress_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ThreadProgress_postId_replyPostId_key" ON "ThreadProgress"("postId", "replyPostId");

-- CreateIndex
CREATE INDEX "ThreadProgress_postId_idx" ON "ThreadProgress"("postId");

-- CreateIndex
CREATE INDEX "ThreadProgress_status_idx" ON "ThreadProgress"("status");
