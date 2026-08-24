/**
 * Language detector unit tests.
 *
 * Source: packages/backend/src/infrastructure/util/language-detector.ts
 */
import { describe, it, expect } from "vitest";
import {
  detectLanguage,
  isLanguageDetectable,
} from "../../../src/infrastructure/util/language-detector.js";

describe("LanguageDetector", () => {
  it("LD-001: detects English", () => {
    expect(detectLanguage("I Love this post about productivity")).toBe("en");
    expect(detectLanguage("What does Workflow Trends even mean")).toBe("en");
  });

  it("LD-004: detects Spanish", () => {
    expect(detectLanguage("Me encanta este post sobre productividad")).toBe("es");
    expect(detectLanguage("Gracias por compartir")).toBe("es");
  });

  it("LD-005: detects Italian", () => {
    expect(detectLanguage("Mi piace questo post sulla produttività")).toBe("it");
    expect(detectLanguage("Grazie per la condivisione")).toBe("it");
  });

  it("LD-008: falls back to English for empty/emoji-only text", () => {
    expect(detectLanguage("")).toBe("en");
    expect(detectLanguage("   ")).toBe("en");
    expect(detectLanguage("✨🎯✨")).toBe("en");
  });

  it("LD-009: returns false for isLanguageDetectable on very short text", () => {
    expect(isLanguageDetectable("hi")).toBe(false);
    expect(isLanguageDetectable("ok")).toBe(false);
  });

  it("LD-010: returns true for isLanguageDetectable on meaningful text", () => {
    expect(isLanguageDetectable("hello world here")).toBe(true);
    expect(isLanguageDetectable("gracias por compartir este post")).toBe(true);
  });

  it("LD-013: detects Spanish and Italian with productivity terms", () => {
    expect(detectLanguage("Un ciclo de producto tarda 18 meses en dar la vuelta al mercado")).toBe(
      "es",
    );
    expect(
      detectLanguage("Un ciclo di prodotto impiega 18 mesi per fare il giro attorno al mercato"),
    ).toBe("it");
  });

  it("LD-015: falls back to English for unsupported Latin languages", () => {
    // German/Dutch short texts are not supported; should fall back to English
    expect(detectLanguage("Das ist ein Test")).toBe("en");
    // Polish is not supported
    expect(detectLanguage("To jest przykład")).toBe("en");
  });

  it("LD-016: isLanguageDetectable requires at least 3 Latin characters", () => {
    expect(isLanguageDetectable("ab")).toBe(false);
    expect(isLanguageDetectable("ab c")).toBe(true);
    expect(isLanguageDetectable("ab")).toBe(false);
    expect(isLanguageDetectable("!!!")).toBe(false);
  });
});
