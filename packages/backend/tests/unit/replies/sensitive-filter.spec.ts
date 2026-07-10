/**
 * RP3: detectSensitive() unit tests.
 *
 * The detector is the hard pre-filter that keeps the auto-reply bot from chirpily replying to
 * grief / crisis / complaint comments. Audience is RU/UA + EN, so coverage spans Cyrillic.
 *
 * Source: packages/backend/src/modules/replies/sensitive-filter.ts
 */
import { describe, it, expect } from 'vitest';

import { detectSensitive, isLikelyTroll, isLowValueComment } from '../../../src/modules/replies/sensitive-filter';

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

describe('isLowValueComment (low-value pre-filter)', () => {
  it('flags emoji-only comments', () => {
    for (const text of ['🔥🔥🔥', '😍', '✨', '🌙💫🔮', '😂😂😂']) {
      const r = isLowValueComment(text);
      expect(r.lowValue, text).toBe(true);
    }
  });

  it('flags pure hashtag comments', () => {
    for (const text of ['#astrology #zodiac', '#horoscope', '#mercuryretrograde']) {
      const r = isLowValueComment(text);
      expect(r.lowValue, text).toBe(true);
    }
  });

  it('flags follow/subscribe bait (EN)', () => {
    for (const text of [
      'follow me for daily horoscopes',
      'follow for follow',
      'f4f anyone?',
      'sub4sub',
      'check my profile for more',
      'visit my channel',
    ]) {
      const r = isLowValueComment(text);
      expect(r.lowValue, text).toBe(true);
    }
  });

  it('flags follow/subscribe bait (RU/UA)', () => {
    for (const text of ['подпишись на меня', 'подписка за подписку', 'підпишись', 'заходи в профиль']) {
      const r = isLowValueComment(text);
      expect(r.lowValue, text).toBe(true);
    }
  });

  it('flags generic one-word reactions (EN)', () => {
    for (const text of ['nice', 'cool', 'great', 'lol', 'first', 'ok', 'wow', 'facts', 'agreed', 'true']) {
      const r = isLowValueComment(text);
      expect(r.lowValue, text).toBe(true);
    }
  });

  it('flags generic one-word reactions (RU/UA)', () => {
    for (const text of ['класс', 'супер', 'круто', 'да', 'ок', 'спасибо', 'дякую', 'красиво']) {
      const r = isLowValueComment(text);
      expect(r.lowValue, text).toBe(true);
    }
  });

  it('flags very short comments (≤3 meaningful chars after stripping)', () => {
    for (const text of ['!', '!!!', '??', '...', '🔥!', 'ok!']) {
      const r = isLowValueComment(text);
      expect(r.lowValue, text).toBe(true);
    }
  });

  it('flags empty comments', () => {
    expect(isLowValueComment('').lowValue).toBe(true);
    expect(isLowValueComment('   ').lowValue).toBe(true);
  });

  it('does NOT flag genuine questions', () => {
    for (const text of [
      'What does Mercury retrograde mean?',
      'Is this accurate for Aries?',
      'When is the next full moon?',
      'Что значит ретроградный Меркурий?',
      'Колись наступає повний місяць?',
    ]) {
      const r = isLowValueComment(text);
      expect(r.lowValue, text).toBe(false);
    }
  });

  it('does NOT flag personal experience sharing', () => {
    for (const text of [
      "This is so accurate for me as a Cancer moon 😭",
      'I felt this deeply, my Venus in Scorpio is exactly like this',
      'Это про меня, я Рак и всё именно так',
    ]) {
      const r = isLowValueComment(text);
      expect(r.lowValue, text).toBe(false);
    }
  });

  it('does NOT flag longer comments that contain generic words', () => {
    // These contain "nice" or "cool" but are longer, meaningful comments
    for (const text of [
      'That is a really nice way to put it, I never thought about it that way',
      'Cool perspective, but what about fire signs specifically?',
    ]) {
      const r = isLowValueComment(text);
      expect(r.lowValue, text).toBe(false);
    }
  });

  it('does NOT flag specific compliments that reference content', () => {
    for (const text of [
      'The part about Venus in Scorpio was spot on',
      'Love how you explained the shadow period',
    ]) {
      const r = isLowValueComment(text);
      expect(r.lowValue, text).toBe(false);
    }
  });

  it('provides a reason when lowValue is true', () => {
    const r = isLowValueComment('🔥🔥🔥');
    expect(r.lowValue).toBe(true);
    expect(r.reason).toBeTruthy();
  });
});
