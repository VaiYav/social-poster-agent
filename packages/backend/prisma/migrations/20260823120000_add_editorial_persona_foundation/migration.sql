-- PERSONA-101 / EP-001..004: immutable editorial persona revisions and account assignments.
-- Additive migration; existing posts remain without inferred persona history.

CREATE TABLE "EditorialPersona" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "EditorialPersona_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "PersonaRevision" (
    "id" TEXT NOT NULL,
    "personaId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "profile" JSONB NOT NULL,
    "checksum" TEXT NOT NULL,
    "safetyPolicyVersion" TEXT NOT NULL,
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "PersonaRevision_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "AccountPersonaAssignment" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "personaId" TEXT NOT NULL,
    "personaRevisionId" TEXT NOT NULL,
    "defaultVoiceMode" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "startsAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "endsAt" TIMESTAMP(3),
    CONSTRAINT "AccountPersonaAssignment_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "EditorialPersona_key_key" ON "EditorialPersona"("key");
CREATE UNIQUE INDEX "PersonaRevision_personaId_version_key" ON "PersonaRevision"("personaId", "version");
CREATE UNIQUE INDEX "PersonaRevision_personaId_checksum_key" ON "PersonaRevision"("personaId", "checksum");
CREATE INDEX "PersonaRevision_personaId_createdAt_idx" ON "PersonaRevision"("personaId", "createdAt");
CREATE INDEX "AccountPersonaAssignment_accountId_active_idx" ON "AccountPersonaAssignment"("accountId", "active");
CREATE INDEX "AccountPersonaAssignment_personaId_startsAt_idx" ON "AccountPersonaAssignment"("personaId", "startsAt");

ALTER TABLE "PersonaRevision" ADD CONSTRAINT "PersonaRevision_personaId_fkey"
  FOREIGN KEY ("personaId") REFERENCES "EditorialPersona"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AccountPersonaAssignment" ADD CONSTRAINT "AccountPersonaAssignment_accountId_fkey"
  FOREIGN KEY ("accountId") REFERENCES "SocialAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AccountPersonaAssignment" ADD CONSTRAINT "AccountPersonaAssignment_personaId_fkey"
  FOREIGN KEY ("personaId") REFERENCES "EditorialPersona"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "AccountPersonaAssignment" ADD CONSTRAINT "AccountPersonaAssignment_personaRevisionId_fkey"
  FOREIGN KEY ("personaRevisionId") REFERENCES "PersonaRevision"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "Post" ADD COLUMN "personaRevisionId" TEXT;
ALTER TABLE "Post" ADD COLUMN "voiceMode" TEXT;
ALTER TABLE "Post" ADD COLUMN "experimentAssignmentId" TEXT;
CREATE INDEX "Post_personaRevisionId_idx" ON "Post"("personaRevisionId");
ALTER TABLE "Post" ADD CONSTRAINT "Post_personaRevisionId_fkey"
  FOREIGN KEY ("personaRevisionId") REFERENCES "PersonaRevision"("id") ON DELETE SET NULL ON UPDATE CASCADE;
