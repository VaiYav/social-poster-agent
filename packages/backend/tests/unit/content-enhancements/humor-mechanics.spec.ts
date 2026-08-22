/**
 * Q5: Humor mechanics unit tests — rotation + prompt guidance.
 * Source: src/modules/content-enhancements/humor-mechanics.ts
 */
import { describe, it, expect } from "vitest";
import { SocialNetwork } from "../../../src/generated/prisma/client";
import {
  pickHumorMechanic,
  getHumorPromptGuidance,
  HUMOR_MECHANICS,
  HUMOR_MECHANICS_BY_ID,
} from "../../../src/modules/content-enhancements/humor-mechanics.js";
import { CONTENT_STYLES } from "../../../src/modules/content-enhancements/content-style.rotation";

describe("Humor Mechanics", () => {
  it("HM-001: pick is deterministic for the same day/network/seed", () => {
    const a = pickHumorMechanic(SocialNetwork.X, "topic-1");
    const b = pickHumorMechanic(SocialNetwork.X, "topic-1");
    expect(a.id).toBe(b.id);
  });

  it("HM-002: different seeds can produce different mechanics", () => {
    const picks = new Set(
      ["t1", "t2", "t3", "t4", "t5", "t6", "t7", "t8"].map(
        (s) => pickHumorMechanic(SocialNetwork.X, s).id,
      ),
    );
    expect(picks.size).toBeGreaterThan(1);
  });

  it("HM-003: guidance includes punchline-last and no-punching-down rules", () => {
    const guidance = getHumorPromptGuidance(HUMOR_MECHANICS[0]!);
    expect(guidance).toContain("punchline");
    expect(guidance).toContain("NEVER at people or groups");
  });

  it("HM-004: null mechanic renders empty guidance (serious styles)", () => {
    expect(getHumorPromptGuidance(null)).toBe("");
  });

  it("HM-005: every mechanic is registered in the lookup map", () => {
    for (const m of HUMOR_MECHANICS) {
      expect(HUMOR_MECHANICS_BY_ID[m.id]).toBe(m);
    }
  });

  it("HM-006: serious content styles are marked humor-incompatible", () => {
    const serious = ["mystical_poem", "ancient_wisdom", "tiny_lesson"];
    for (const style of CONTENT_STYLES) {
      if (serious.includes(style.id)) {
        expect(style.humorCompatible).toBe(false);
      } else {
        expect(style.humorCompatible).toBe(true);
      }
    }
  });
});
