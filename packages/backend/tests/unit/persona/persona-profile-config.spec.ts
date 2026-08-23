import { describe, expect, it } from "vitest";
import { createMockConfigService } from "../../mocks/index.js";
import { loadPersonaProfiles } from "../../../src/modules/persona/persona-profile-config.js";

describe("Persona profile Markdown configuration", () => {
  it("loads and validates deployment profiles from YAML/JSON frontmatter", async () => {
    const profiles = await loadPersonaProfiles(
      createMockConfigService({ PERSONA_PROFILES_PATH: "config/personas.example.md" }),
    );

    expect(Object.keys(profiles)).toEqual(["cosmic_analyst", "rhythm_companion"]);
    expect(profiles.cosmic_analyst?.profile.identity.role).toContain("astrology");
    expect(profiles.rhythm_companion?.defaultVoiceMode).toBe("gentle_reflection");
  });

  it("returns no seeds when the deployment does not configure a profile path", async () => {
    await expect(loadPersonaProfiles(createMockConfigService())).resolves.toEqual({});
  });

  it("treats a missing configured file as an empty deployment config", async () => {
    await expect(
      loadPersonaProfiles(createMockConfigService({ PERSONA_PROFILES_PATH: "config/missing-personas.md" })),
    ).resolves.toEqual({});
  });
});
