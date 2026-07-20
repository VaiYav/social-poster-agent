-- AlterTable
ALTER TABLE "SocialAccount" ADD COLUMN     "displayName" TEXT,
ADD COLUMN     "fingerprintSeed" TEXT,
ADD COLUMN     "groupId" TEXT,
ADD COLUMN     "priority" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "proxyUrl" TEXT;

-- CreateTable
CREATE TABLE "AccountGroup" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "proxyUrl" TEXT,
    "timezone" TEXT,
    "fingerprintProfile" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AccountGroup_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "SocialAccount_priority_idx" ON "SocialAccount"("priority");

-- CreateIndex
CREATE INDEX "SocialAccount_groupId_idx" ON "SocialAccount"("groupId");

-- AddForeignKey
ALTER TABLE "SocialAccount" ADD CONSTRAINT "SocialAccount_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "AccountGroup"("id") ON DELETE SET NULL ON UPDATE CASCADE;
