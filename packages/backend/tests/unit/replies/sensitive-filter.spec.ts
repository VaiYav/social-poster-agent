/**
 * RP3: detectSensitive() unit tests.
 *
 * The detector is the hard pre-filter that keeps the auto-reply bot from chirpily replying to
 * grief / crisis / complaint comments. Audience is RU/UA + EN, so coverage spans Cyrillic.
 *
 * Source: packages/backend/src/modules/replies/sensitive-filter.ts
 */
import { describe, it, expect } from 'vitest';

import { detectSensitive, isLikelyTroll } from '../../../src/modules/replies/sensitive-filter';

describe('detectSensitive (RP3 — sensitive-topic backstop)', () => {
  it('flags English crisis/mental-health comments', () => {
    for (const text of [
      "I've been really depressed lately",
      'sometimes I think about suicide',
      'the grief is too much right now',
      'struggling with my mental health',
    ]) {
      const r = detectSensitive(text);
      expect(r.sensitive, text).toBe(true);
      expect(r.kind, text).toBe('crisis');
    }
  });

  it('flags Russian/Ukrainian crisis comments (the actual audience)', () => {
    for (const text of [
      'у меня депрессия и тревога',
      'хочу покончить со всем',
      'это такое горе, не могу',
      'пережил тяжёлую травму',
      'у мене криза, дуже погано',
    ]) {
      const r = detectSensitive(text);
      expect(r.sensitive, text).toBe(true);
      expect(r.kind, text).toBe('crisis');
    }
  });

  it('flags complaints in EN and RU/UA', () => {
    for (const text of [
      'this is just wrong and misleading',
      'so disappointed, refund please',
      'это обман, верните деньги',
      'розчарований повністю',
    ]) {
      const r = detectSensitive(text);
      expect(r.sensitive, text).toBe(true);
      expect(r.kind, text).toBe('complaint');
    }
  });

  it('does NOT flag ordinary positive/neutral comments', () => {
    for (const text of [
      'Love this horoscope! 🌙',
      'When is Mercury retrograde?',
      'Спасибо большое за прогноз ✨',
      'Дякую, дуже точно',
      'Город красивый сегодня', // "гор" must not trigger "горе"
    ]) {
      const r = detectSensitive(text);
      expect(r.sensitive, text).toBe(false);
    }
  });

  it('prioritises crisis over complaint when both could match', () => {
    const r = detectSensitive('this is wrong and I am so depressed about it');
    expect(r.sensitive).toBe(true);
    expect(r.kind).toBe('crisis');
  });

  it('handles empty/whitespace safely', () => {
    expect(detectSensitive('').sensitive).toBe(false);
    expect(detectSensitive('   ').sensitive).toBe(false);
  });
});

describe('isLikelyTroll (RP-troll — word-boundary)', () => {
  it('flags obvious troll/spam', () => {
    for (const text of ['this is spam', 'you are an idiot', 'stupid bot', 'nazi propaganda', 'total scam']) {
      expect(isLikelyTroll(text), text).toBe(true);
    }
  });

  it('does NOT flag benign comments that merely contain a keyword substring', () => {
    for (const text of [
      'tell me about my sign', // "about" contains "bot"
      'I studied astrology for years', // "studied" contains "die"
      'what a great skill set', // "skill" contains "kill"
      'indie vibes this season', // "indie" contains "die"
      'I appreciate the update', // no troll word
    ]) {
      expect(isLikelyTroll(text), text).toBe(false);
    }
  });
});
