import { z } from "zod";

export const PersonaVoiceModeSchema = z.object({
  id: z.string().min(1).max(80),
  purpose: z.string().min(1).max(500),
  promptRules: z.array(z.string().min(1).max(500)).max(20),
  allowedFirstPerson: z.boolean(),
});

export const PersonaContentPillarSchema = z.object({
  id: z.string().min(1).max(80),
  description: z.string().min(1).max(500),
  riskClass: z.enum(["LOW", "SENSITIVE", "HIGH"]),
});

export const PersonaNetworkAdapterSchema = z.object({
  toneRules: z.array(z.string().min(1).max(500)).max(20),
  disclosure: z.string().max(500).optional(),
  maxCharacters: z.number().int().positive().max(100_000).optional(),
});

export const PersonaProfileSchema = z.object({
  identity: z.object({
    role: z.string().min(1).max(500),
    worldview: z.array(z.string().min(1).max(500)).min(1).max(20),
    temperament: z.array(z.string().min(1).max(200)).min(1).max(20),
    expertise: z.array(z.string().min(1).max(200)).min(1).max(20),
    audienceJob: z.string().min(1).max(500),
    disclosure: z.string().min(1).max(500),
  }),
  voice: z.object({
    warmth: z.number().min(0).max(1),
    assertiveness: z.number().min(0).max(1),
    humor: z.enum(["none", "dry", "warm", "playful"]),
    sentenceRhythm: z.string().min(1).max(500),
    vocabulary: z.array(z.string().min(1).max(100)).max(50),
    bannedPatterns: z.array(z.string().min(1).max(200)).max(50),
  }),
  modes: z.array(PersonaVoiceModeSchema).min(1).max(20),
  contentPillars: z.array(PersonaContentPillarSchema).min(1).max(20),
  networkAdapters: z.record(z.string(), PersonaNetworkAdapterSchema),
  firstPersonPolicy: z.object({
    mode: z.enum(["NONE", "APPROVED_EPISODE_ONLY"]),
    requireApprovedMemory: z.boolean(),
  }),
  claimPolicy: z.object({
    factualEvidenceRequired: z.boolean(),
    sensitiveDomains: z.array(z.string().min(1).max(100)).max(20),
  }),
});

export type PersonaProfile = z.infer<typeof PersonaProfileSchema>;
export type PersonaVoiceMode = z.infer<typeof PersonaVoiceModeSchema>;
export type PersonaContentPillar = z.infer<typeof PersonaContentPillarSchema>;

export const PersonaAssignmentSchema = z.object({
  personaId: z.string().min(1),
  personaRevisionId: z.string().min(1),
  defaultVoiceMode: z.string().min(1).max(80),
  startsAt: z.coerce.date().optional(),
});
export type PersonaAssignment = z.infer<typeof PersonaAssignmentSchema>;

export const CreatePersonaSchema = z.object({
  key: z.string().regex(/^[a-z][a-z0-9_]{1,79}$/),
  displayName: z.string().min(1).max(120),
  profile: PersonaProfileSchema,
});
export type CreatePersona = z.infer<typeof CreatePersonaSchema>;

export const CreatePersonaRevisionSchema = z.object({
  profile: PersonaProfileSchema,
  createdBy: z.string().max(120).optional(),
  safetyPolicyVersion: z.string().min(1).max(120).optional(),
});
export type CreatePersonaRevision = z.infer<typeof CreatePersonaRevisionSchema>;
