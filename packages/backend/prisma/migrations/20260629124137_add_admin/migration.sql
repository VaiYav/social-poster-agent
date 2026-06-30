-- AlterEnum (IF NOT EXISTS for idempotency — enum value may already exist)
ALTER TYPE "GenerationTrigger" ADD VALUE IF NOT EXISTS 'AUTONOMOUS';

-- CreateTable (IF NOT EXISTS for idempotency)
CREATE TABLE IF NOT EXISTS "Admin" (
    "id" TEXT NOT NULL,
    "username" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Admin_pkey" PRIMARY KEY ("id")
);

-- CreateIndex (IF NOT EXISTS for idempotency)
CREATE UNIQUE INDEX IF NOT EXISTS "Admin_username_key" ON "Admin"("username");
