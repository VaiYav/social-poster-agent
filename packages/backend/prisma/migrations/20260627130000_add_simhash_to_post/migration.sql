-- AlterTable
-- Sprint L: Add precomputed SimHash column for fast content dedup.
-- Nullable because existing posts don't have a hash yet (computed lazily on next generation).
ALTER TABLE "Post" ADD COLUMN "simhash" TEXT;

-- CreateIndex
CREATE INDEX "Post_simhash_idx" ON "Post"("simhash");
