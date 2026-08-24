-- ROADMAP_V2 M1.2: per-account settings overrides (docs/roadmap/02).
-- JSONB validated by AccountSettingsSchema in @spa/shared; absence of the
-- column value means "inherit from global env / defaults".

ALTER TABLE "SocialAccount" ADD COLUMN "settings" JSONB;
