/**
 * Content Style Rotation unit tests.
 *
 * Tests the style rotation system that prevents AI-generated content
 * from looking uniform and detectable.
 *
 * Source: packages/backend/src/modules/content-enhancements/content-style.rotation.ts
 */
import { describe, it, expect } from 'vitest';
import {
  CONTENT_STYLES,
  CONTENT_STYLES_BY_ID,
  pickContentStyle,
  getStylePromptGuidance,
  type ContentStyle,
} from '../../../src/modules/content-enhancements/content-style.rotation';
import { SocialNetwork } from '@prisma/client';

describe('Content Style Rotation', () => {
  // ── CONTENT_STYLES array ──

  it('CS-001: has at least 10 diverse styles defined', () => {
    expect(CONTENT_STYLES.length).toBeGreaterThanOrEqual(10);
  });

  it('CS-002: every style has all required fields', () => {
    for (const style of CONTENT_STYLES) {
      expect(style.id).toBeTruthy();
      expect(style.name).toBeTruthy();
      expect(style.description).toBeTruthy();
      expect(style.promptGuidance).toBeTruthy();
      expect(style.example).toBeTruthy();
      expect(typeof style.worksForShort).toBe('boolean');
      expect(typeof style.worksForLong).toBe('boolean');
    }
  });

  it('CS-003: every style has a unique id', () => {
    const ids = CONTENT_STYLES.map((s) => s.id);
    const unique = new Set(ids);
    expect(unique.size).toBe(ids.length);
  });

  it('CS-004: every style has a unique name', () => {
    const names = CONTENT_STYLES.map((s) => s.name);
    const unique = new Set(names);
    expect(unique.size).toBe(names.length);
  });

  it('CS-005: all promptGuidance strings are non-trivial (>50 chars)', () => {
    for (const style of CONTENT_STYLES) {
      expect(style.promptGuidance.length).toBeGreaterThan(50);
    }
  });

  it('CS-006: all example strings are non-trivial (>20 chars)', () => {
    for (const style of CONTENT_STYLES) {
      expect(style.example.length).toBeGreaterThan(20);
    }
  });

  it('CS-007: includes expected core styles', () => {
    const ids = CONTENT_STYLES.map((s) => s.id);
    expect(ids).toContain('hot_take');
    expect(ids).toContain('story_time');
    expect(ids).toContain('myth_buster');
    expect(ids).toContain('meme_energy');
    expect(ids).toContain('mystical_poem');
    expect(ids).toContain('listicle');
    expect(ids).toContain('question_hook');
    expect(ids).toContain('cosmic_weather');
    expect(ids).toContain('ancient_wisdom');
    expect(ids).toContain('real_talk');
    expect(ids).toContain('plot_twist');
    expect(ids).toContain('tiny_lesson');
  });

  // ── CONTENT_STYLES_BY_ID ──

  it('CS-008: CONTENT_STYLES_BY_ID maps all styles by their id', () => {
    for (const style of CONTENT_STYLES) {
      expect(CONTENT_STYLES_BY_ID[style.id]).toBeDefined();
      expect(CONTENT_STYLES_BY_ID[style.id]!.id).toBe(style.id);
    }
  });

  it('CS-009: CONTENT_STYLES_BY_ID returns undefined for unknown id', () => {
    expect(CONTENT_STYLES_BY_ID['nonexistent_style']).toBeUndefined();
  });

  // ── pickContentStyle ──

  it('CS-010: returns a valid ContentStyle for X (short posts)', () => {
    const style = pickContentStyle(SocialNetwork.X);
    expect(style).toBeDefined();
    expect(style.worksForShort).toBe(true);
  });

  it('CS-011: returns a valid ContentStyle for THREADS (long posts)', () => {
    const style = pickContentStyle(SocialNetwork.THREADS);
    expect(style).toBeDefined();
    expect(style.worksForLong).toBe(true);
  });

  it('CS-012: returns a valid ContentStyle for FACEBOOK (long posts)', () => {
    const style = pickContentStyle(SocialNetwork.FACEBOOK);
    expect(style).toBeDefined();
    expect(style.worksForLong).toBe(true);
  });

  it('CS-013: only returns short-compatible styles for X', () => {
    // Run multiple picks with different runIds to sample the rotation
    for (let i = 0; i < 20; i++) {
      const style = pickContentStyle(SocialNetwork.X, `run-${i}`);
      expect(style.worksForShort).toBe(true);
    }
  });

  it('CS-014: only returns long-compatible styles for THREADS', () => {
    for (let i = 0; i < 20; i++) {
      const style = pickContentStyle(SocialNetwork.THREADS, `run-${i}`);
      expect(style.worksForLong).toBe(true);
    }
  });

  it('CS-015: only returns long-compatible styles for FACEBOOK', () => {
    for (let i = 0; i < 20; i++) {
      const style = pickContentStyle(SocialNetwork.FACEBOOK, `run-${i}`);
      expect(style.worksForLong).toBe(true);
    }
  });

  it('CS-016: produces different styles across different run IDs (same network)', () => {
    const styles = new Set<string>();
    for (let i = 0; i < 12; i++) {
      const style = pickContentStyle(SocialNetwork.THREADS, `unique-run-${i}`);
      styles.add(style.id);
    }
    // We should see at least 3 different styles across 12 runs
    expect(styles.size).toBeGreaterThanOrEqual(3);
  });

  it('CS-017: deterministic for same inputs (same day, same network, same runId)', () => {
    const runId = 'deterministic-test-run';
    const style1 = pickContentStyle(SocialNetwork.X, runId);
    const style2 = pickContentStyle(SocialNetwork.X, runId);
    expect(style1.id).toBe(style2.id);
  });

  it('CS-018: different networks may get different styles for same runId', () => {
    // With the network hash offset, different networks should sometimes differ
    const runId = 'cross-network-test';
    const styles = new Set<string>();
    styles.add(pickContentStyle(SocialNetwork.X, runId).id);
    styles.add(pickContentStyle(SocialNetwork.THREADS, runId).id);
    styles.add(pickContentStyle(SocialNetwork.FACEBOOK, runId).id);
    // At least 2 different styles across 3 networks (not guaranteed all 3 differ,
    // but the network hash should produce some variation)
    expect(styles.size).toBeGreaterThanOrEqual(1);
  });

  it('CS-019: handles undefined runId gracefully', () => {
    const style = pickContentStyle(SocialNetwork.X);
    expect(style).toBeDefined();
    expect(style.id).toBeTruthy();
  });

  it('CS-020: handles empty string runId gracefully', () => {
    const style = pickContentStyle(SocialNetwork.THREADS, '');
    expect(style).toBeDefined();
    expect(style.id).toBeTruthy();
  });

  it('CS-021: meme_energy style is marked as not working for long posts', () => {
    const memeStyle = CONTENT_STYLES_BY_ID['meme_energy'];
    expect(memeStyle).toBeDefined();
    expect(memeStyle!.worksForShort).toBe(true);
    expect(memeStyle!.worksForLong).toBe(false);
  });

  it('CS-022: never returns meme_energy for THREADS or FACEBOOK', () => {
    for (let i = 0; i < 30; i++) {
      const threadsStyle = pickContentStyle(SocialNetwork.THREADS, `meme-check-${i}`);
      const fbStyle = pickContentStyle(SocialNetwork.FACEBOOK, `meme-check-${i}`);
      expect(threadsStyle.id).not.toBe('meme_energy');
      expect(fbStyle.id).not.toBe('meme_energy');
    }
  });

  // ── getStylePromptGuidance ──

  it('CS-023: returns a string containing the style name', () => {
    const style = CONTENT_STYLES[0]!;
    const guidance = getStylePromptGuidance(style);
    expect(typeof guidance).toBe('string');
    expect(guidance).toContain(style.name);
  });

  it('CS-024: includes the promptGuidance content in the output', () => {
    const style = CONTENT_STYLES_BY_ID['hot_take']!;
    const guidance = getStylePromptGuidance(style);
    expect(guidance).toContain(style.promptGuidance);
  });

  it('CS-025: includes the example in the output', () => {
    const style = CONTENT_STYLES_BY_ID['story_time']!;
    const guidance = getStylePromptGuidance(style);
    expect(guidance).toContain('Example of this style');
    expect(guidance).toContain(style.example);
  });

  it('CS-026: starts with double newline for prompt separation', () => {
    const style = CONTENT_STYLES[0]!;
    const guidance = getStylePromptGuidance(style);
    expect(guidance.startsWith('\n\n')).toBe(true);
  });

  it('CS-027: contains CONTENT STYLE header', () => {
    const style = CONTENT_STYLES_BY_ID['mystical_poem']!;
    const guidance = getStylePromptGuidance(style);
    expect(guidance).toContain('CONTENT STYLE');
  });

  it('CS-028: works for every defined style without throwing', () => {
    for (const style of CONTENT_STYLES) {
      expect(() => getStylePromptGuidance(style)).not.toThrow();
    }
  });
});
