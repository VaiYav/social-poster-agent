-- AlterEnum
-- Adding PAUSED status to GenerationRunStatus for Sprint I pause/resume.
-- Paused runs are not failures — they can be resumed from the last checkpoint.
ALTER TYPE "GenerationRunStatus" ADD VALUE 'PAUSED';
