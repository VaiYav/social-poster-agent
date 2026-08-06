/**
 * F4.D: Tone analyzer — rule-based tone detection for reply tone matching.
 */
import { describe, it, expect } from 'vitest';
import { ToneAnalyzerService } from '../../../src/modules/replies/tone-analyzer.service';

describe('ToneAnalyzerService', () => {
  const svc = new ToneAnalyzerService();

  it('F4-D1: detects casual tone with slang and emojis', () => {
    const result = svc.detectTone('lol that\'s so true for my cancer moon 😂', 'en');
    expect(result.tone).toBe('casual');
    expect(result.confidence).toBeGreaterThan(0);
  });

  it('F4-D2: detects formal tone with polite request', () => {
    const result = svc.detectTone('Dear team, could you please clarify the meaning of this transit?', 'en');
    expect(result.tone).toBe('formal');
  });

  it('F4-D3: detects playful tone with exclamation and emoji', () => {
    const result = svc.detectTone('Omg yes!!! 🎉 Venus in Scorpio is WILD!', 'en');
    expect(result.tone).toBe('playful');
  });

  it('F4-D4: detects sarcastic tone', () => {
    const result = svc.detectTone('Oh great, another Mercury retrograde. Just what I needed.', 'en');
    expect(result.tone).toBe('sarcastic');
  });

  it('F4-D5: detects sincere tone', () => {
    const result = svc.detectTone('Honestly, thank you so much for this, it really helped me understand.', 'en');
    expect(result.tone).toBe('sincere');
  });

  it('F4-D6: returns neutral for plain text with no markers', () => {
    const result = svc.detectTone('The post was about Mars entering Gemini.', 'en');
    expect(result.tone).toBe('neutral');
    expect(result.confidence).toBeGreaterThan(0);
  });

  it('F4-D7: works with Cyrillic casual markers', () => {
    const result = svc.detectTone('ахах, класс, спасибо', 'ru');
    expect(result.tone).toBe('casual');
  });

  it('F4-D8: works with Cyrillic formal markers', () => {
    const result = svc.detectTone('Будьте добры, прошу вас объяснить этот аспект', 'ru');
    expect(result.tone).toBe('formal');
  });

  it('F4-D9: does not lose emoji detection across sequential calls', () => {
    // Stateful /g regex would miss emojis on the second call; match() should not.
    const first = svc.detectTone('plain text', 'en');
    expect(first.tone).toBe('neutral');
    const second = svc.detectTone('🔥🔥🔥 wow', 'en');
    expect(second.tone).toBe('playful');
    const third = svc.detectTone('this is great 😂', 'en');
    expect(third.tone).toBe('playful');
  });

  it('F4-D10: detects all-caps across Latin, Cyrillic and Spanish accents', () => {
    const upperCyrillic = svc.detectTone('ЭТО ПРОСТО ВЕЛИКОЛЕПНО!!!', 'ru');
    expect(upperCyrillic.tone).toBe('playful');

    const upperSpanish = svc.detectTone('¡GENIAL! ME ENCANTA', 'es');
    expect(upperSpanish.tone).toBe('playful');

    const upperItalian = svc.detectTone('FANTASTICO! GRAZIE MILLE', 'it');
    expect(upperItalian.tone).toBe('playful');
  });

  it('F4-D11: does not crash on emoji-only or non-alphabetic input', () => {
    const result = svc.detectTone('🌙✨🔮', 'en');
    // Emoji-only is a playful signal; the point is no NaN/crash on zero letters.
    expect(result.tone).toBe('playful');
    expect(result.confidence).toBeGreaterThan(0);
  });
});
