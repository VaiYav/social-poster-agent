-- UpdatePostVariantIndexes
DROP INDEX IF EXISTS "PostVariant_postId_idx";
DROP INDEX IF EXISTS "PostVariant_network_idx";

CREATE INDEX "PostVariant_postId_network_idx" ON "PostVariant"("postId", "network");
CREATE INDEX "PostVariant_network_selected_postedAt_idx" ON "PostVariant"("network", "selected", "postedAt");
