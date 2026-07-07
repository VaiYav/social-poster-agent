/**
 * Language detector unit tests.
 *
 * Source: packages/backend/src/infrastructure/util/language-detector.ts
 */
import { describe, it, expect } from 'vitest';
import { detectLanguage, isLanguageDetectable } from '../../../src/infrastructure/util/language-detector';

describe('LanguageDetector', () => {
  it('LD-001: detects English', () => {
    expect(detectLanguage('I love this post about astrology')).toBe('en');
    expect(detectLanguage('What does Mercury retrograde even mean')).toBe('en');
  });

  it('LD-002: detects Russian', () => {
    expect(detectLanguage('Спасибо за пост, очень интересно')).toBe('ru');
    expect(detectLanguage('Луна в Раке сегодня')).toBe('ru');
  });

  it('LD-003: detects Ukrainian', () => {
    expect(detectLanguage('Дякую за пост, дуже цікаво')).toBe('uk');
    expect(detectLanguage('Місяць у Раку сьогодні')).toBe('uk');
  });

  it('LD-004: detects Spanish', () => {
    expect(detectLanguage('Me encanta este post sobre astrología')).toBe('es');
    expect(detectLanguage('Gracias por compartir')).toBe('es');
  });

  it('LD-005: detects Italian', () => {
    expect(detectLanguage('Mi piace questo post sull\'astrologia')).toBe('it');
    expect(detectLanguage('Grazie per la condivisione')).toBe('it');
  });

  it('LD-006: distinguishes Ukrainian from Russian by specific characters', () => {
    expect(detectLanguage('Це є правда')).toBe('uk');
    expect(detectLanguage('Це їхнє рішення')).toBe('uk');
    expect(detectLanguage('Мені ґрунтовно')).toBe('uk');
  });

  it('LD-007: distinguishes Russian from Ukrainian by specific characters', () => {
    expect(detectLanguage('Это правда')).toBe('ru');
    expect(detectLanguage('Мы с тобой')).toBe('ru');
    expect(detectLanguage('Съешь ещё этих мягких французских булок')).toBe('ru');
  });

  it('LD-008: falls back to English for empty/emoji-only text', () => {
    expect(detectLanguage('')).toBe('en');
    expect(detectLanguage('   ')).toBe('en');
    expect(detectLanguage('✨🔮✨')).toBe('en');
  });

  it('LD-009: returns false for isLanguageDetectable on very short text', () => {
    expect(isLanguageDetectable('hi')).toBe(false);
    expect(isLanguageDetectable('ok')).toBe(false);
  });

  it('LD-010: returns true for isLanguageDetectable on meaningful text', () => {
    expect(isLanguageDetectable('hello world here')).toBe(true);
    expect(isLanguageDetectable('Спасибо за пост')).toBe(true);
  });
});
