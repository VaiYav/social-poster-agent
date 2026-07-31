/**
 * MOD-FC: Flow Control Service unit tests.
 *
 * Traces to: Phase 5.3 — Redis MGET optimization.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { FlowControlService, type FlowName } from '../../../src/modules/flow-control/flow-control.service';
import { createMockRedis, createMockSseService } from '../../mocks/index.js';

describe('MOD-FC: FlowControlService', () => {
  let service: FlowControlService;
  let redis: ReturnType<typeof createMockRedis>;
  let sse: ReturnType<typeof createMockSseService>;

  beforeEach(() => {
    redis = createMockRedis();
    sse = createMockSseService();
    service = new FlowControlService(redis as never, sse as never);
  });

  it('FC-001: isPaused uses a single MGET for pause_all + flow key', async () => {
    redis.mget.mockResolvedValue([null, '1']);

    const result = await service.isPaused('generation');

    expect(redis.mget).toHaveBeenCalledTimes(1);
    expect(redis.mget).toHaveBeenCalledWith(['flow:pause_all', 'flow:pause_generation']);
    expect(result).toBe(true);
  });

  it('FC-002: isPaused returns false when no pause flags are set', async () => {
    redis.mget.mockResolvedValue([null, null]);

    const result = await service.isPaused('posting');

    expect(result).toBe(false);
  });

  it('FC-003: isPaused returns true when pause_all is set', async () => {
    redis.mget.mockResolvedValue(['1', null]);

    const result = await service.isPaused('engagement');

    expect(result).toBe(true);
  });

  it('FC-004: getStatus uses a single MGET for all keys', async () => {
    redis.mget.mockResolvedValue(['1', null, '1', null, null, null, null]);

    const status = await service.getStatus();

    expect(redis.mget).toHaveBeenCalledTimes(1);
    expect(redis.mget).toHaveBeenCalledWith([
      'flow:pause_all',
      'flow:pause_generation',
      'flow:pause_posting',
      'flow:pause_engagement',
      'flow:pause_replies',
      'flow:pause_llm_triage',
      'flow:pause_auto_approve',
    ]);
    expect(status.pauseAll).toBe(true);
    expect(status.flows).toEqual({
      generation: true,
      posting: true,
      engagement: true,
      replies: true,
      llm_triage: true,
      auto_approve: true,
    });
  });

  it('FC-005: getStatus computes per-flow pause correctly when pause_all is unset', async () => {
    redis.mget.mockResolvedValue([null, null, '1', null, '1', null, null]);

    const status = await service.getStatus();

    expect(status.pauseAll).toBe(false);
    expect(status.flows).toEqual({
      generation: false,
      posting: true,
      engagement: false,
      replies: true,
      llm_triage: false,
      auto_approve: false,
    });
  });

  it('FC-006: pause sets the flow-specific flag and publishes SSE', async () => {
    await service.pause('replies', 'manual pause');

    expect(redis.set).toHaveBeenCalledWith('flow:pause_replies', '1');
    expect(sse.publish).toHaveBeenCalledWith({
      type: 'flow_control',
      action: 'paused',
      flow: 'replies',
      reason: 'manual pause',
    });
  });

  it('FC-007: pauseAll sets the global flag and publishes SSE', async () => {
    await service.pauseAll('emergency');

    expect(redis.set).toHaveBeenCalledWith('flow:pause_all', '1');
    expect(sse.publish).toHaveBeenCalledWith({
      type: 'flow_control',
      action: 'pause_all',
      reason: 'emergency',
    });
  });

  it('FC-008: resume deletes the flow-specific flag and publishes SSE', async () => {
    await service.resume('posting');

    expect(redis.del).toHaveBeenCalledWith('flow:pause_posting');
    expect(sse.publish).toHaveBeenCalledWith({
      type: 'flow_control',
      action: 'resumed',
      flow: 'posting',
      reason: null,
    });
  });

  it('FC-PAUSE-001: pauses and resumes llm_triage flow', async () => {
    await service.pause('llm_triage', 'queue triage on fire');
    expect(redis.set).toHaveBeenCalledWith('flow:pause_llm_triage', '1');
    expect(sse.publish).toHaveBeenCalledWith({
      type: 'flow_control',
      action: 'paused',
      flow: 'llm_triage',
      reason: 'queue triage on fire',
    });

    await service.resume('llm_triage');
    expect(redis.del).toHaveBeenCalledWith('flow:pause_llm_triage');
  });

  it('FC-PAUSE-002: pauses and resumes auto_approve flow', async () => {
    await service.pause('auto_approve', 'judge drift');
    expect(redis.set).toHaveBeenCalledWith('flow:pause_auto_approve', '1');
    expect(sse.publish).toHaveBeenCalledWith({
      type: 'flow_control',
      action: 'paused',
      flow: 'auto_approve',
      reason: 'judge drift',
    });

    await service.resume('auto_approve');
    expect(redis.del).toHaveBeenCalledWith('flow:pause_auto_approve');
  });

  it('FC-009: resumeAll deletes all pause flags and publishes SSE', async () => {
    await service.resumeAll();

    expect(redis.del).toHaveBeenCalledWith('flow:pause_all');
    for (const flow of ['generation', 'posting', 'engagement', 'replies', 'llm_triage', 'auto_approve'] as FlowName[]) {
      expect(redis.del).toHaveBeenCalledWith(`flow:pause_${flow}`);
    }
    expect(sse.publish).toHaveBeenCalledWith({
      type: 'flow_control',
      action: 'resume_all',
    });
  });

  it('FC-010: assertNotPaused throws when a flow is paused', async () => {
    redis.mget.mockResolvedValue(['1', null]);

    await expect(service.assertNotPaused('generation')).rejects.toThrow(
      "Flow 'generation' is paused — skipping new work",
    );
  });

  it('FC-011: assertNotPaused resolves when a flow is not paused', async () => {
    redis.mget.mockResolvedValue([null, null]);

    await expect(service.assertNotPaused('generation')).resolves.toBeUndefined();
  });
});
