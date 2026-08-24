-- ROADMAP_V2 M0.1: link attribution fields (my_zodiac_ai/back attribution-links client).
-- ctaUrl          — final CTA URL placed in the post text (zodiac short link or direct UTM fallback)
-- attributionLinkId — AttributionLink.id in zodiac-back; NULL means the direct-UTM fallback was used
-- attributionSlug — denormalized slug for funnel-report lookups and dashboards

ALTER TABLE "Post" ADD COLUMN "ctaUrl" TEXT;
ALTER TABLE "Post" ADD COLUMN "attributionLinkId" TEXT;
ALTER TABLE "Post" ADD COLUMN "attributionSlug" TEXT;

CREATE INDEX "Post_attributionSlug_idx" ON "Post"("attributionSlug");
