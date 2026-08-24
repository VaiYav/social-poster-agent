/**
 * Tests for script-check utility — post-generation script validation.
 *
 * This is NOT language detection. The LLM detects the language; this module
 * only verifies that the LLM's output uses the script consistent with the
 * language it claimed. Catches the #1 bot tell: English reply to non-English.
 */
import { describe, it, expect } from "vitest";
import { matchesScript, normalizeLanguage } from "../../../src/infrastructure/util/script-check.js";

describe("script-check — matchesScript", () => {
  it("SC-001: accepts Latin text for en, es, it", () => {
    expect(matchesScript("Product cycle hit me at 28", "en")).toBe(true);
    expect(matchesScript("Un ciclo de producto tarda 18 meses en dar la vuelta", "es")).toBe(true);
    expect(matchesScript("Un ciclo di prodotto impiega 18 mesi per fare il giro", "it")).toBe(true);
  });

  it("SC-002: rejects Cyrillic-dominant text for Latin languages", () => {
    expect(matchesScript("абвгд все о плане работы", "en")).toBe(false);
    expect(matchesScript("абвгд все о плане работы", "es")).toBe(false);
    expect(matchesScript("абвгд все о плане работы", "it")).toBe(false);
  });

  it("SC-003: accepts empty/whitespace/emoji/number text without judgement", () => {
    expect(matchesScript("", "en")).toBe(true);
    expect(matchesScript("   ", "es")).toBe(true);
    expect(matchesScript("🎉✨🚀", "it")).toBe(true);
    expect(matchesScript("28 18 100", "en")).toBe(true);
  });

  it("SC-004: handles very short Latin text", () => {
    expect(matchesScript("Yes", "en")).toBe(true);
    expect(matchesScript("Si", "es")).toBe(true);
    expect(matchesScript("Si", "it")).toBe(true);
  });

  it("SC-005: accepts unknown language gracefully", () => {
    expect(matchesScript("Product cycle", "de" as never)).toBe(true);
    expect(matchesScript("абвгд", "de" as never)).toBe(true);
  });
});

describe("script-check — normalizeLanguage", () => {
  it("NL-001: returns supported languages as-is", () => {
    expect(normalizeLanguage("en")).toBe("en");
    expect(normalizeLanguage("es")).toBe("es");
    expect(normalizeLanguage("it")).toBe("it");
  });

  it("NL-002: normalises case", () => {
    expect(normalizeLanguage("EN")).toBe("en");
    expect(normalizeLanguage("ES")).toBe("es");
    expect(normalizeLanguage("It")).toBe("it");
  });

  it("NL-003: maps locale variants", () => {
    expect(normalizeLanguage("en-US")).toBe("en");
    expect(normalizeLanguage("es-ES")).toBe("es");
    expect(normalizeLanguage("it-IT")).toBe("it");
  });

  it("NL-004: defaults to en for unknown codes", () => {
    expect(normalizeLanguage("de")).toBe("en");
    expect(normalizeLanguage("fr")).toBe("en");
    expect(normalizeLanguage("zh")).toBe("en");
  });

  it("NL-005: defaults to en for null/undefined/empty", () => {
    expect(normalizeLanguage(null)).toBe("en");
    expect(normalizeLanguage(undefined)).toBe("en");
    expect(normalizeLanguage("")).toBe("en");
    expect(normalizeLanguage("  ")).toBe("en");
  });

  it("NL-006: handles mixed-case locale variants", () => {
    expect(normalizeLanguage("EN-us")).toBe("en");
    expect(normalizeLanguage("ES-es")).toBe("es");
    expect(normalizeLanguage("IT-it")).toBe("it");
  });

  it("NL-007: handles malformed locale strings gracefully", () => {
    expect(normalizeLanguage("en-US-INVALID")).toBe("en");
    expect(normalizeLanguage("  es  ")).toBe("es");
  });

  it("NL-008: normalizes 3-letter and padded uppercase codes", () => {
    expect(normalizeLanguage("ITA")).toBe("it");
    expect(normalizeLanguage("ES ")).toBe("es");
    expect(normalizeLanguage(" EN")).toBe("en");
  });
});
