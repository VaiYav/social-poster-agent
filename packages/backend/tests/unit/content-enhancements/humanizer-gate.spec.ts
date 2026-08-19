/**
 * Q6: Humanizer Gate unit tests — deterministic statistical AI-tell scan.
 * Source: src/modules/content-enhancements/humanizer-gate.ts
 */
import { describe, it, expect } from 'vitest';
import { analyzeHumanization, buildHumanizeInstruction } from '../../../src/modules/content-enhancements/humanizer-gate.js';

// Human-sounding text: varied sentence lengths, no slop, no em dashes.
const CLEAN_TEXT =
  'Product cycle again. I spent forty minutes staring at my project plan last night and the coffee started tasting like regret. Fine, lesson learned.';

describe('Humanizer Gate', () => {
  it('HG-001: clean human text passes the gate (null instruction)', () => {
    expect(buildHumanizeInstruction(CLEAN_TEXT, 'en')).toBeNull();
    const report = analyzeHumanization(CLEAN_TEXT, 'en');
    expect(report.flags).toHaveLength(0);
  });

  it('HG-002: em dashes are flagged and counted', () => {
    const text = 'Product cycle returns — always on time. The workflow — meanwhile — waits.';
    const report = analyzeHumanization(text, 'en');
    expect(report.emDashCount).toBe(3);
    const instruction = buildHumanizeInstruction(text, 'en');
    expect(instruction).toContain('em/en dashes');
  });

  it('HG-003: uniform sentence lengths are flagged (low burstiness)', () => {
    const text = 'The workflow rules your inbox tonight. The brand rules your public image now. Productivity rules your anger and drive.';
    const report = analyzeHumanization(text, 'en');
    expect(report.uniformSentences).toBe(true);
    expect(buildHumanizeInstruction(text, 'en')).toContain('under 6 words');
  });

  it('HG-004: varied sentence lengths are NOT flagged', () => {
    const report = analyzeHumanization(CLEAN_TEXT, 'en');
    expect(report.uniformSentences).toBe(false);
  });

  it('HG-005: slop words trigger the gate', () => {
    const en = buildHumanizeInstruction('Unlock the powerful secrets of your plan.', 'en');
    expect(en).toContain('"unlock"');
    const es = buildHumanizeInstruction('En el mundo actual, la productividad transforma todo.', 'es');
    expect(es).toContain('en el mundo actual');
  });

  it('HG-006: hashtags trigger the gate', () => {
    const report = analyzeHumanization('Workflow is wild today. #productivity #workflow', 'en');
    expect(report.hashtagCount).toBe(2);
    expect(buildHumanizeInstruction('Workflow. #productivity', 'en')).toContain('hashtags');
  });

  it('HG-007: single-sentence post is not penalized for burstiness', () => {
    const report = analyzeHumanization('Workflow broke my phone again.', 'en');
    expect(report.uniformSentences).toBe(false);
    expect(report.flags).toHaveLength(0);
  });
});
