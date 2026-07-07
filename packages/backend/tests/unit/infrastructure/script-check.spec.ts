/**
 * Tests for script-check utility — post-generation script validation.
 *
 * This is NOT language detection. The LLM detects the language; this module
 * only verifies that the LLM's output uses the script consistent with the
 * language it claimed. Catches the #1 bot tell: English reply to non-English.
 */
import { describe, it, expect } from 'vitest';
import { matchesScript, normalizeLanguage } from '../../../src/infrastructure/util/script-check';

describe('script-check — matchesScript', () => {
  // ── Cyrillic languages (ru, uk) ──

  it('SC-001: accepts Cyrillic text for ru', () => {
    expect(matchesScript('Сатурн вернулся в 28', 'ru')).toBe(true);
  });

  it('SC-002: accepts Cyrillic text for uk', () => {
    expect(matchesScript('Сатурн повернувся в 28', 'uk')).toBe(true);
  });

  it('SC-003: rejects Latin-only text for ru (English reply to Russian comment)', () => {
    expect(matchesScript('Saturn return hit me at 28 too', 'ru')).toBe(false);
  });

  it('SC-004: rejects Latin-only text for uk (English reply to Ukrainian comment)', () => {
    expect(matchesScript('Thanks for sharing this!', 'uk')).toBe(false);
  });

  it('SC-005: accepts mixed Cyrillic+Latin for ru when Cyrillic dominates', () => {
    // Ukrainian post with English astrology term — Cyrillic dominates
    expect(matchesScript('Меркурий retrograde — это реально', 'ru')).toBe(true);
  });

  it('SC-006: rejects mixed text for ru when Latin dominates', () => {
    // Mostly English with one Cyrillic word
    expect(matchesScript('Love this post about космос', 'ru')).toBe(false);
  });

  // ── Latin languages (en, es, it) ──

  it('SC-007: accepts Latin text for en', () => {
    expect(matchesScript('Saturn return hit me at 28', 'en')).toBe(true);
  });

  it('SC-008: accepts Latin text for es', () => {
    expect(matchesScript('Saturno tarda 29.5 años en dar la vuelta', 'es')).toBe(true);
  });

  it('SC-009: accepts Latin text for it', () => {
    expect(matchesScript('Saturno impiega 29.5 anni per fare il giro', 'it')).toBe(true);
  });

  it('SC-010: rejects Cyrillic-only text for en', () => {
    expect(matchesScript('Спасибо за пост', 'en')).toBe(false);
  });

  it('SC-011: rejects Cyrillic-only text for es', () => {
    expect(matchesScript('Gracias por el post', 'es')).toBe(true); // Latin — OK
    expect(matchesScript('Дякую за пост', 'es')).toBe(false); // Cyrillic — mismatch
  });

  // ── Edge cases ──

  it('SC-012: accepts empty text (let caller decide)', () => {
    expect(matchesScript('', 'ru')).toBe(true);
    expect(matchesScript('', 'en')).toBe(true);
  });

  it('SC-013: accepts whitespace-only text', () => {
    expect(matchesScript('   ', 'ru')).toBe(true);
  });

  it('SC-014: accepts emoji-only text (not enough alpha to judge)', () => {
    expect(matchesScript('🔮✨🌙', 'ru')).toBe(true);
    expect(matchesScript('🔮✨🌙', 'en')).toBe(true);
  });

  it('SC-015: accepts text with numbers only', () => {
    expect(matchesScript('28 29.5 100', 'ru')).toBe(true);
  });

  it('SC-016: accepts unknown language (let LLM judgement stand)', () => {
    // normalizeLanguage('de') → 'en', so callers always pass a supported lang.
    // But matchesScript should still accept any string gracefully (defensive).
    expect(matchesScript('Saturn return', 'de' as never)).toBe(true);
    expect(matchesScript('Спасибо', 'de' as never)).toBe(true);
  });

  it('SC-017: handles very short Cyrillic text', () => {
    expect(matchesScript('Так', 'uk')).toBe(true);
    expect(matchesScript('Yes', 'uk')).toBe(false);
  });

  it('SC-018: handles very short Latin text', () => {
    expect(matchesScript('Yes', 'en')).toBe(true);
    expect(matchesScript('Так', 'en')).toBe(false);
  });
});

describe('script-check — normalizeLanguage', () => {
  it('NL-001: returns supported languages as-is', () => {
    expect(normalizeLanguage('en')).toBe('en');
    expect(normalizeLanguage('ru')).toBe('ru');
    expect(normalizeLanguage('uk')).toBe('uk');
    expect(normalizeLanguage('es')).toBe('es');
    expect(normalizeLanguage('it')).toBe('it');
  });

  it('NL-002: normalises case', () => {
    expect(normalizeLanguage('EN')).toBe('en');
    expect(normalizeLanguage('RU')).toBe('ru');
    expect(normalizeLanguage('Uk')).toBe('uk');
  });

  it('NL-003: maps locale variants', () => {
    expect(normalizeLanguage('en-US')).toBe('en');
    expect(normalizeLanguage('ru-RU')).toBe('ru');
    expect(normalizeLanguage('uk-UA')).toBe('uk');
    expect(normalizeLanguage('es-ES')).toBe('es');
    expect(normalizeLanguage('it-IT')).toBe('it');
  });

  it('NL-004: defaults to en for unknown codes', () => {
    expect(normalizeLanguage('de')).toBe('en');
    expect(normalizeLanguage('fr')).toBe('en');
    expect(normalizeLanguage('zh')).toBe('en');
  });

  it('NL-005: defaults to en for null/undefined/empty', () => {
    expect(normalizeLanguage(null)).toBe('en');
    expect(normalizeLanguage(undefined)).toBe('en');
    expect(normalizeLanguage('')).toBe('en');
    expect(normalizeLanguage('  ')).toBe('en');
  });

  it('NL-006: handles mixed-case locale variants', () => {
    expect(normalizeLanguage('EN-us')).toBe('en');
    expect(normalizeLanguage('RU-ru')).toBe('ru');
    expect(normalizeLanguage('UK-ua')).toBe('uk');
  });

  it('NL-007: handles malformed locale strings gracefully', () => {
    expect(normalizeLanguage('en-US-INVALID')).toBe('en');
    expect(normalizeLanguage('ru_RU')).toBe('ru');
    expect(normalizeLanguage('  es  ')).toBe('es');
  });
});
