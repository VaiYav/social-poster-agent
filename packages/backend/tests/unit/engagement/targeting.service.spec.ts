/**
 * TargetingService unit tests.
 *
 * Tests source rotation, URL building, and weighted picking.
 *
 * Source: packages/backend/src/modules/engagement/targeting.service.ts
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ConfigService } from '@nestjs/config';
import { TargetingService } from '../../../src/modules/engagement/targeting.service';

function createMockConfigService(overrides: Record<string, unknown> = {}): ConfigService {
  return {
    get: vi.fn((key: string, defaultValue?: unknown) => overrides[key] ?? defaultValue),
  } as unknown as ConfigService;
}

describe('TargetingService', () => {
  let service: TargetingService;

  beforeEach(() => {
    vi.clearAllMocks();
    service = new TargetingService(createMockConfigService());
  });

  // ── pickSource ──

  it('TG-001: pickSource() returns a TargetSource with url and label', () => {
    const result = service.pickSource('X');
    expect(result).toHaveProperty('source');
    expect(result).toHaveProperty('url');
    expect(result).toHaveProperty('label');
  });

  it('TG-002: pickSource() returns different sources across calls (weighted distribution)', () => {
    const sources = new Set<string>();
    for (let i = 0; i < 100; i++) {
      sources.add(service.pickSource('X').source);
    }
    // Should hit at least 3 different source types in 100 calls
    expect(sources.size).toBeGreaterThanOrEqual(3);
  });

  // ── getAvailableSources ──

  it('TG-003: getAvailableSources() returns all 5 source types for X', () => {
    const sources = service.getAvailableSources('X');
    const sourceTypes = sources.map((s) => s.source);
    expect(sourceTypes).toContain('home-feed');
    expect(sourceTypes).toContain('hashtag');
    expect(sourceTypes).toContain('competitor');
    expect(sourceTypes).toContain('explore');
    expect(sourceTypes).toContain('notifications');
  });

  it('TG-004: getAvailableSources() includes explore for X.com', () => {
    const sources = service.getAvailableSources('X');
    const explore = sources.find((s) => s.source === 'explore');
    expect(explore).toBeDefined();
    expect(explore!.url).toBe('https://x.com/explore');
  });

  it('TG-005: getAvailableSources() includes search for Threads', () => {
    const sources = service.getAvailableSources('THREADS');
    const explore = sources.find((s) => s.source === 'explore');
    expect(explore).toBeDefined();
    expect(explore!.url).toContain('threads.com/search');
  });

  it('TG-006: getAvailableSources() builds correct hashtag URLs', () => {
    const sources = service.getAvailableSources('X');
    const hashtag = sources.find((s) => s.source === 'hashtag');
    expect(hashtag).toBeDefined();
    expect(hashtag!.url).toContain('x.com/search');
    expect(hashtag!.hashtag).toBeDefined();
  });

  it('TG-007: getAvailableSources() builds correct competitor URLs', () => {
    const sources = service.getAvailableSources('X');
    const competitor = sources.find((s) => s.source === 'competitor');
    expect(competitor).toBeDefined();
    expect(competitor!.url).toContain('x.com/');
    expect(competitor!.competitorHandle).toBeDefined();
  });

  // ── URL builders ──

  it('TG-008: home feed URL is correct for each network', () => {
    expect(service.getAvailableSources('X').find((s) => s.source === 'home-feed')!.url).toBe('https://x.com/home');
    expect(service.getAvailableSources('THREADS').find((s) => s.source === 'home-feed')!.url).toBe('https://www.threads.com/');
  });

  it('TG-009: notifications URL is correct for each network', () => {
    expect(service.getAvailableSources('X').find((s) => s.source === 'notifications')!.url).toBe('https://x.com/notifications');
    expect(service.getAvailableSources('THREADS').find((s) => s.source === 'notifications')!.url).toBe('https://www.threads.com/activity');
  });

  // ── Config ──

  it('TG-010: uses custom hashtags from config', () => {
    const custom = new TargetingService(createMockConfigService({
      ENGAGEMENT_HASHTAGS: '#custom1,#custom2',
    }));
    expect(custom.getHashtags()).toEqual(['#custom1', '#custom2']);
  });

  it('TG-011: uses custom competitors from config', () => {
    const custom = new TargetingService(createMockConfigService({
      ENGAGEMENT_COMPETITORS: 'comp1,comp2',
    }));
    expect(custom.getCompetitors()).toEqual(['comp1', 'comp2']);
  });

  it('TG-012: handles empty hashtag/competitor config', () => {
    const custom = new TargetingService(createMockConfigService({
      ENGAGEMENT_HASHTAGS: '',
      ENGAGEMENT_COMPETITORS: '',
    }));
    expect(custom.getHashtags()).toEqual([]);
    expect(custom.getCompetitors()).toEqual([]);
    // Should still work — just no hashtag/competitor sources
    const sources = custom.getAvailableSources('X');
    expect(sources.find((s) => s.source === 'hashtag')).toBeUndefined();
    expect(sources.find((s) => s.source === 'competitor')).toBeUndefined();
  });
});
