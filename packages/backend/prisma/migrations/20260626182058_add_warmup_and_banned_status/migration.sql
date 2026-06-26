-- CreateEnum
CREATE TYPE "InteractionType" AS ENUM ('LIKE', 'COMMENT', 'FOLLOW', 'UNFOLLOW', 'REPLY', 'SCROLL_VIEW');

-- CreateEnum
CREATE TYPE "InteractionStatus" AS ENUM ('PENDING', 'IN_PROGRESS', 'COMPLETED', 'FAILED', 'SKIPPED');

-- CreateEnum
CREATE TYPE "BrowsingSessionStatus" AS ENUM ('ACTIVE', 'COMPLETED', 'FAILED', 'ABORTED');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "SessionStatus" ADD VALUE 'WARMUP';
ALTER TYPE "SessionStatus" ADD VALUE 'BANNED';

-- AlterTable
ALTER TABLE "SocialAccount" ADD COLUMN     "warmupDaysTotal" INTEGER NOT NULL DEFAULT 7,
ADD COLUMN     "warmupEnabled" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "warmupStartedAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "Interaction" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "type" "InteractionType" NOT NULL,
    "status" "InteractionStatus" NOT NULL DEFAULT 'PENDING',
    "targetUrl" TEXT,
    "targetHandle" TEXT,
    "content" TEXT,
    "errorMessage" TEXT,
    "screenshotPath" TEXT,
    "browsingSessionId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "Interaction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BrowsingSession" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "status" "BrowsingSessionStatus" NOT NULL DEFAULT 'ACTIVE',
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "endedAt" TIMESTAMP(3),
    "durationSec" INTEGER NOT NULL DEFAULT 0,
    "postsViewed" INTEGER NOT NULL DEFAULT 0,
    "interactionsCount" INTEGER NOT NULL DEFAULT 0,
    "feedUrl" TEXT,
    "errorMessage" TEXT,

    CONSTRAINT "BrowsingSession_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Interaction_accountId_idx" ON "Interaction"("accountId");

-- CreateIndex
CREATE INDEX "Interaction_type_idx" ON "Interaction"("type");

-- CreateIndex
CREATE INDEX "Interaction_status_idx" ON "Interaction"("status");

-- CreateIndex
CREATE INDEX "Interaction_browsingSessionId_idx" ON "Interaction"("browsingSessionId");

-- CreateIndex
CREATE INDEX "Interaction_createdAt_idx" ON "Interaction"("createdAt");

-- CreateIndex
CREATE INDEX "BrowsingSession_accountId_idx" ON "BrowsingSession"("accountId");

-- CreateIndex
CREATE INDEX "BrowsingSession_status_idx" ON "BrowsingSession"("status");

-- CreateIndex
CREATE INDEX "BrowsingSession_startedAt_idx" ON "BrowsingSession"("startedAt");

-- AddForeignKey
ALTER TABLE "Interaction" ADD CONSTRAINT "Interaction_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "SocialAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Interaction" ADD CONSTRAINT "Interaction_browsingSessionId_fkey" FOREIGN KEY ("browsingSessionId") REFERENCES "BrowsingSession"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BrowsingSession" ADD CONSTRAINT "BrowsingSession_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "SocialAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;
