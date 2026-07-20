-- AlterTable
ALTER TABLE "ContentSource" ADD COLUMN     "lastError" TEXT;

-- AlterTable
ALTER TABLE "IncomingComment" ADD COLUMN     "conversationId" TEXT,
ADD COLUMN     "depth" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "isQuestion" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "parentId" TEXT,
ADD COLUMN     "questionConfidence" DOUBLE PRECISION,
ADD COLUMN     "questionType" TEXT,
ADD COLUMN     "replyUrl" TEXT;

-- CreateIndex
CREATE INDEX "IncomingComment_conversationId_depth_idx" ON "IncomingComment"("conversationId", "depth");

-- CreateIndex
CREATE INDEX "IncomingComment_parentId_idx" ON "IncomingComment"("parentId");

-- AddForeignKey
ALTER TABLE "IncomingComment" ADD CONSTRAINT "IncomingComment_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "IncomingComment"("id") ON DELETE SET NULL ON UPDATE CASCADE;
