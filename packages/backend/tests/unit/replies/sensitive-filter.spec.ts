/**
 * RP3: detectSensitive() unit tests.
 *
 * The detector is the hard pre-filter that keeps the auto-reply bot from chirpily replying to
 * grief / crisis / complaint comments.
 *
 * Source: packages/backend/src/modules/replies/sensitive-filter.ts
 */
import { describe, it, expect } from 'vitest';

import { detectSensitive, isLikelyTroll, isLowValueComment } from '../../../src/modules/replies/sensitive-filter.js';

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

  it('flags complaints in English', () => {
    for (const text of [
      'this is just wrong and misleading',
      'so disappointed, refund please',
    ]) {
      const r = detectSensitive(text);
      expect(r.sensitive, text).toBe(true);
      expect(r.kind, text).toBe('complaint');
    }
  });

  it('does NOT flag ordinary positive/neutral comments', () => {
    for (const text of [
      'Love this newsletter! 🌙',
      'When is Workflow Trends?',
      'Great update, thanks for sharing',
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
      'I studied productivity for years', // "studied" contains "die"
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
    for (const text of ['#productivity #workflow', '#newsletter', '#WorkflowTrends']) {
      const r = isLowValueComment(text);
      expect(r.lowValue, text).toBe(true);
    }
  });

  it('flags follow/subscribe bait (EN)', () => {
    for (const text of [
      'follow me for daily newsletters',
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

  it('flags generic one-word reactions (EN)', () => {
    for (const text of ['nice', 'cool', 'great', 'lol', 'first', 'ok', 'wow', 'facts', 'agreed', 'true']) {
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
      'What does Workflow Trends mean?',
      'Is this accurate for Q1?',
      'When is the next product launch?',
    ]) {
      const r = isLowValueComment(text);
      expect(r.lowValue, text).toBe(false);
    }
  });

  it('does NOT flag personal experience sharing', () => {
    for (const text of [
      "This is so accurate for me as a Customer Feedback 😭",
      'I felt this deeply, my Customer Feedback in crisis is exactly like this',
    ]) {
      const r = isLowValueComment(text);
      expect(r.lowValue, text).toBe(false);
    }
  });

  it('does NOT flag longer comments that contain generic words', () => {
    // These contain "nice" or "cool" but are longer, meaningful comments
    for (const text of [
      'That is a really nice way to put it, I never thought about it that way',
      'Cool perspective, but what about target segments specifically?',
    ]) {
      const r = isLowValueComment(text);
      expect(r.lowValue, text).toBe(false);
    }
  });

  it('does NOT flag specific compliments that reference content', () => {
    for (const text of [
      'The part about Customer Feedback in crisis was spot on',
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
