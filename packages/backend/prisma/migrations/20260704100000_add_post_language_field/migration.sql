-- AlterTable
-- Add language field to Post (ISO 639-1 code: en, ru, uk, es, it)
-- Default 'en' for backward compatibility with existing posts
ALTER TABLE "Post" ADD COLUMN "language" TEXT NOT NULL DEFAULT 'en';
