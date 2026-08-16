-- The syndication fields were present in schema.prisma but missing from the
-- production migration history. Keep this migration idempotent because some
-- environments may already contain a subset of the fields.
DO $$
BEGIN
  CREATE TYPE "ContentType" AS ENUM ('SOCIAL_POST', 'ARTICLE', 'ANSWER', 'PIN');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

ALTER TABLE "Post" ADD COLUMN IF NOT EXISTS "contentType" "ContentType" NOT NULL DEFAULT 'SOCIAL_POST';
ALTER TABLE "Post" ADD COLUMN IF NOT EXISTS "canonicalUrl" TEXT;
ALTER TABLE "Post" ADD COLUMN IF NOT EXISTS "syndicatedUrls" JSONB;
ALTER TABLE "Post" ADD COLUMN IF NOT EXISTS "judgeScores" JSONB;
ALTER TABLE "Post" ADD COLUMN IF NOT EXISTS "judgeRetried" BOOLEAN NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS "Post_contentType_idx" ON "Post"("contentType");
CREATE INDEX IF NOT EXISTS "Post_canonicalUrl_idx" ON "Post"("canonicalUrl");
