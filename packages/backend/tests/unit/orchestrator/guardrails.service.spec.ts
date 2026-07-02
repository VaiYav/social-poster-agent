/**
 * GuardrailsService unit tests.
 *
 * Source: packages/backend/src/modules/orchestrator/guardrails.service.ts
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { SocialNetwork, SessionStatus } from '@prisma/client';
import { GuardrailsService } from '../../../src/modules/orchestrator/guardrails.service';
import type { Action, WorldState } from '../../../src/modules/orchestrator/types';

function makeWorld(overrides: Partial<WorldState> = {}): WorldState {
  return {
    timestamp: 0,
    topicPool: { count: 0, threshold: 0, oldestAgeMs: 0 },
    drafts: { pending: 0, approved: 0, rejected: 0 },
    queueDepth: {},
    sessions: {},
    rateLimits: {},
    now: 0,
    utcHour: 0,
    utcDayOfWeek: 0,
    postingWindows: {},
    inPostingWindow: {},
    performance: {},
    engagement: { lastBrowseMs: {}, uncheckedReplies: 0, warmupPhase: {} },
    health: { bans: 0, dlqDepth: 0, stuckPosting: 0, orphanedPosts: 0, killSwitch: false },
    trends: { lastRefreshMs: 0, count: 0 },
    flowControl: {
      pauseAll: false,
      pauseGeneration: false,
      pausePosting: false,
      pauseEngagement: false,
      pauseReplies: false,
    },
    _degraded: [],
    _collectedAt: 0,
    ...overrides,
  };
}

const POST_ACTION: Action = { type: 'POST', network: SocialNetwork.X, reason: 'test', source: 'llm' };
const BROWSE_ACTION: Action = { type: 'BROWSE', network: SocialNetwork.X, reason: 'test', source: 'llm' };
const WAIT_ACTION: Action = { type: 'WAIT', reason: 'test', source: 'llm' };

describe('GuardrailsService', () => {
  let guardrails: GuardrailsService;

  beforeEach(() => {
    guardrails = new GuardrailsService();
  });

  it('G4: session down + POST → returns RECOVER_SESSION when flow is not paused', () => {
    const world = makeWorld({
      sessions: { X: { status: SessionStatus.EXPIRED, lastCheckMs: 0, circuitBreaker: 'closed' } },
      rateLimits: { X: { dailyRemaining: 10, weeklyRemaining: 50, minIntervalMs: 0, lastPostMs: 0 } },
    });

    const result = guardrails.apply(POST_ACTION, world);

    expect(result.type).toBe('RECOVER_SESSION');
  });

  it('G4+G7: session down + POST but pausePosting is set → WAIT, not RECOVER_SESSION (regression for the flow-control gap)', () => {
    const world = makeWorld({
      sessions: { X: { status: SessionStatus.EXPIRED, lastCheckMs: 0, circuitBreaker: 'closed' } },
      rateLimits: { X: { dailyRemaining: 10, weeklyRemaining: 50, minIntervalMs: 0, lastPostMs: 0 } },
      flowControl: {
        pauseAll: false,
        pauseGeneration: false,
        pausePosting: true,
        pauseEngagement: false,
        pauseReplies: false,
      },
    });

    const result = guardrails.apply(POST_ACTION, world);

    expect(result.type).toBe('WAIT');
    expect(result.reason).toMatch(/Flow paused for POST/);
  });

  it('G4+G7: session down + BROWSE but pauseEngagement is set → WAIT, not RECOVER_SESSION', () => {
    const world = makeWorld({
      sessions: { X: { status: SessionStatus.EXPIRED, lastCheckMs: 0, circuitBreaker: 'closed' } },
      flowControl: {
        pauseAll: false,
        pauseGeneration: false,
        pausePosting: false,
        pauseEngagement: true,
        pauseReplies: false,
      },
    });

    const result = guardrails.apply(BROWSE_ACTION, world);

    expect(result.type).toBe('WAIT');
    expect(result.reason).toMatch(/Flow paused for BROWSE/);
  });

  it('G7: CHECK_REPLIES paused via pauseReplies → WAIT (action type not covered by G4)', () => {
    const action: Action = { type: 'CHECK_REPLIES', network: SocialNetwork.X, reason: 'test', source: 'llm' };
    const world = makeWorld({
      flowControl: {
        pauseAll: false,
        pauseGeneration: false,
        pausePosting: false,
        pauseEngagement: false,
        pauseReplies: true,
      },
    });

    const result = guardrails.apply(action, world);

    expect(result.type).toBe('WAIT');
  });

  it('G8: WAIT + approved drafts + network in posting window → POST', () => {
    const world = makeWorld({
      drafts: { pending: 0, approved: 5, rejected: 0 },
      sessions: {
        X: { status: SessionStatus.ACTIVE, lastCheckMs: 0, circuitBreaker: 'closed' },
      },
      rateLimits: { X: { dailyRemaining: 10, weeklyRemaining: 50, minIntervalMs: 0, lastPostMs: 0 } },
      inPostingWindow: { X: true },
    });

    const result = guardrails.apply(WAIT_ACTION, world);

    expect(result.type).toBe('POST');
    expect(result.network).toBe(SocialNetwork.X);
    expect(result.source).toBe('guardrail_override');
  });

  it('G8: rotates to the network with the oldest lastPostMs', () => {
    const world = makeWorld({
      drafts: { pending: 0, approved: 5, rejected: 0 },
      sessions: {
        X: { status: SessionStatus.ACTIVE, lastCheckMs: 0, circuitBreaker: 'closed' },
        THREADS: { status: SessionStatus.ACTIVE, lastCheckMs: 0, circuitBreaker: 'closed' },
      },
      rateLimits: {
        X: { dailyRemaining: 10, weeklyRemaining: 50, minIntervalMs: 0, lastPostMs: Date.now() },
        THREADS: { dailyRemaining: 10, weeklyRemaining: 50, minIntervalMs: 0, lastPostMs: Date.now() - 3600000 },
      },
      inPostingWindow: { X: true, THREADS: true },
    });

    const result = guardrails.apply(WAIT_ACTION, world);

    expect(result.type).toBe('POST');
    expect(result.network).toBe(SocialNetwork.THREADS);
    expect(result.source).toBe('guardrail_override');
  });

  it('passes the action through unchanged when no guardrail fires', () => {
    const world = makeWorld({
      sessions: { X: { status: SessionStatus.ACTIVE, lastCheckMs: 0, circuitBreaker: 'closed' } },
      rateLimits: { X: { dailyRemaining: 10, weeklyRemaining: 50, minIntervalMs: 0, lastPostMs: 0 } },
    });

    const result = guardrails.apply(POST_ACTION, world);

    expect(result).toBe(POST_ACTION);
  });
});
