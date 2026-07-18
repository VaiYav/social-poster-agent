-- AddSourcePath
ALTER TABLE "Post" ADD COLUMN "sourcePath" TEXT;

-- Backfill sourcePath from sourceRef.path for existing rows
UPDATE "Post"
SET "sourcePath" = "sourceRef"->>'path'
WHERE "sourceRef" ? 'path';

-- CreateIndex
CREATE INDEX "Post_sourcePath_network_idx" ON "Post"("sourcePath", "network");
