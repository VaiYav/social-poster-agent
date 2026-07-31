/**
 * Q6: Humanizer Gate unit tests — deterministic statistical AI-tell scan.
 * Source: src/modules/content-enhancements/humanizer-gate.ts
 */
import { describe, it, expect } from 'vitest';
import { analyzeHumanization, buildHumanizeInstruction } from '../../../src/modules/content-enhancements/humanizer-gate.js';

// Human-sounding text: varied sentence lengths, no slop, no em dashes.
const CLEAN_TEXT =
  'Saturn again. I spent forty minutes staring at my natal chart last night and the coffee started tasting like regret. Fine, lesson learned.';

describe('Humanizer Gate', () => {
  it('HG-001: clean human text passes the gate (null instruction)', () => {
    expect(buildHumanizeInstruction(CLEAN_TEXT, 'en')).toBeNull();
    const report = analyzeHumanization(CLEAN_TEXT, 'en');
    expect(report.flags).toHaveLength(0);
  });

  it('HG-002: em dashes are flagged and counted', () => {
    const text = 'Saturn returns — always on time. The moon — meanwhile — waits.';
    const report = analyzeHumanization(text, 'en');
    expect(report.emDashCount).toBe(3);
    const instruction = buildHumanizeInstruction(text, 'en');
    expect(instruction).toContain('em/en dashes');
  });

  it('HG-003: uniform sentence lengths are flagged (low burstiness)', () => {
    const text = 'The moon rules your feelings tonight. The sun rules your public image now. Mars rules your anger and drive.';
    const report = analyzeHumanization(text, 'en');
    expect(report.uniformSentences).toBe(true);
    expect(buildHumanizeInstruction(text, 'en')).toContain('under 6 words');
  });

  it('HG-004: varied sentence lengths are NOT flagged', () => {
    const report = analyzeHumanization(CLEAN_TEXT, 'en');
    expect(report.uniformSentences).toBe(false);
  });

  it('HG-005: slop words trigger the gate (multilingual)', () => {
    const en = buildHumanizeInstruction('Unlock the powerful secrets of your chart.', 'en');
    expect(en).toContain('"unlock"');
    const ru = buildHumanizeInstruction('В современном мире астрология помогает всем нам жить лучше и осознаннее каждый день.', 'ru');
    expect(ru).toContain('в современном мире');
  });

  it('HG-006: hashtags trigger the gate (Latin and Cyrillic)', () => {
    const report = analyzeHumanization('Mercury is wild today. #astrology #гороскоп', 'en');
    expect(report.hashtagCount).toBe(2);
    expect(buildHumanizeInstruction('Mercury. #astrology', 'en')).toContain('hashtags');
  });

  it('HG-007: single-sentence post is not penalized for burstiness', () => {
    const report = analyzeHumanization('Mercury broke my phone again.', 'en');
    expect(report.uniformSentences).toBe(false);
    expect(report.flags).toHaveLength(0);
  });
});
