-- CreateTable
CREATE TABLE "Topic" (
    "id" TEXT NOT NULL,
    "topic" TEXT NOT NULL,
    "keywords" JSONB NOT NULL,
    "facts" JSONB NOT NULL,
    "category" TEXT NOT NULL DEFAULT 'general',
    "sourceType" TEXT NOT NULL DEFAULT 'llm',
    "status" TEXT NOT NULL DEFAULT 'active',
    "usedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Topic_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Topic_status_idx" ON "Topic"("status");

-- CreateIndex
CREATE INDEX "Topic_category_idx" ON "Topic"("category");

-- CreateIndex
CREATE INDEX "Topic_createdAt_idx" ON "Topic"("createdAt");
