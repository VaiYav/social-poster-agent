import { describe, expect, it, beforeEach } from "vitest";
import { SocialNetwork } from "../../../src/generated/prisma/client.js";
import { PersonaProfileSchema } from "@spa/shared";
import {
  PersonaProfileService,
  profileChecksum,
} from "../../../src/modules/persona/persona-profile.service.js";
import { loadPersonaProfiles, type PersonaSeedProfiles } from "../../../src/modules/persona/persona-profile-config.js";
import { createMockConfigService, createMockPrismaService } from "../../mocks/index.js";

describe("PERSONA-101 PersonaProfileService", () => {
  let prisma: ReturnType<typeof createMockPrismaService>;
  let service: PersonaProfileService;
  let personaProfiles: PersonaSeedProfiles;

  beforeEach(async () => {
    prisma = createMockPrismaService();
    personaProfiles = await loadPersonaProfiles(
      createMockConfigService({ PERSONA_PROFILES_PATH: "config/personas.example.md" }),
    );
    service = new PersonaProfileService(
      prisma as never,
      createMockConfigService(),
    );
  });

  it("validates and creates an immutable version-one revision", async () => {
    const definition = personaProfiles.cosmic_analyst!;
    prisma.editorialPersona.create.mockResolvedValue({ id: "persona-1", key: "cosmic_analyst" });
    prisma.personaRevision.create.mockResolvedValue({ id: "revision-1", version: 1 });

    const result = await service.createPersona({
      key: "cosmic_analyst",
      displayName: definition.displayName,
      profile: definition.profile,
    });

    expect(result.revision).toMatchObject({ id: "revision-1", version: 1 });
    expect(prisma.personaRevision.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        version: 1,
        checksum: profileChecksum(definition.profile),
        safetyPolicyVersion: "persona-policy-v1",
      }),
    });
  });

  it("increments revision versions and preserves immutable checksums", async () => {
    const definition = personaProfiles.rhythm_companion!;
    prisma.personaRevision.findFirst.mockResolvedValue({ version: 3 });
    prisma.personaRevision.create.mockResolvedValue({ id: "revision-4", version: 4 });

    await service.createRevision({ personaId: "persona-1", profile: definition.profile });

    expect(prisma.personaRevision.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        personaId: "persona-1",
        version: 4,
        checksum: profileChecksum(definition.profile),
      }),
    });
  });

  it("deactivates the previous account assignment inside the same transaction", async () => {
    prisma.personaRevision.findUnique.mockResolvedValue({ personaId: "persona-1" });
    prisma.accountPersonaAssignment.updateMany.mockResolvedValue({ count: 1 });
    prisma.accountPersonaAssignment.create.mockResolvedValue({ id: "assignment-2", active: true });

    await service.assign({
      accountId: "account-1",
      personaId: "persona-1",
      personaRevisionId: "revision-1",
      defaultVoiceMode: "pattern_breakdown",
    });

    expect(prisma.accountPersonaAssignment.updateMany).toHaveBeenCalledWith({
      where: { accountId: "account-1", active: true },
      data: expect.objectContaining({ active: false, endsAt: expect.any(Date) }),
    });
    expect(prisma.accountPersonaAssignment.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        accountId: "account-1",
        personaRevisionId: "revision-1",
        defaultVoiceMode: "pattern_breakdown",
      }),
    });
  });

  it("returns a safe global fallback when the account has no assignment", async () => {
    prisma.accountPersonaAssignment.findFirst.mockResolvedValue(null);

    await expect(
      service.resolve({ accountId: "account-1", network: SocialNetwork.X }),
    ).resolves.toMatchObject({
      accountId: "account-1",
      personaId: null,
      personaRevisionId: null,
      source: "GLOBAL_FALLBACK",
      voiceMode: "default",
    });
  });

  it("resolves an assigned profile and rejects an unknown voice mode", async () => {
    const definition = personaProfiles.cosmic_analyst!;
    prisma.accountPersonaAssignment.findFirst.mockResolvedValue({
      accountId: "account-1",
      personaId: "persona-1",
      personaRevisionId: "revision-1",
      defaultVoiceMode: definition.defaultVoiceMode,
      persona: { id: "persona-1" },
      personaRevision: {
        id: "revision-1",
        safetyPolicyVersion: "persona-policy-v1",
        profile: definition.profile,
      },
    });

    await expect(
      service.resolve({ accountId: "account-1", network: SocialNetwork.X }),
    ).resolves.toMatchObject({
      personaId: "persona-1",
      personaRevisionId: "revision-1",
      voiceMode: "pattern_breakdown",
      source: "PERSONA",
      disclosure: definition.profile.identity.disclosure,
    });

    await expect(
      service.resolve({
        accountId: "account-1",
        network: SocialNetwork.X,
        requestedVoiceMode: "missing-mode",
      }),
    ).rejects.toThrow("Voice mode missing-mode");
  });

  it("keeps default profiles valid against the shared schema", () => {
    for (const definition of Object.values(personaProfiles)) {
      expect(() => PersonaProfileSchema.parse(definition.profile)).not.toThrow();
    }
  });
});
