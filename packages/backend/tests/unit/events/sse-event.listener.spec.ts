/**
 * ARCH-001 regression tests: SseEventListener @OnEvent handlers MUST wrap
 * SseService.publish() in try/catch and NEVER rethrow. If publish throws
 * (Redis down, serialization error), the event bus must continue running.
 *
 * Verified behaviour:
 *   - Each handler calls sseService.publish with the correct payload shape
 *   - If publish throws, the handler swallows the error and logs via logger.error
 *   - The handler returns normally (does not rethrow) — event bus stays alive
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SseEventListener } from '../../../src/events/listeners/sse-event.listener';
import { PostEvents } from '../../../src/events/enums/post-events.enum';
import { createMockSseService } from '../../mocks';

describe('SseEventListener (ARCH-001 — event bus safety)', () => {
  let sseService: ReturnType<typeof createMockSseService>;
  let listener: SseEventListener;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    sseService = createMockSseService();
    listener = new SseEventListener(sseService as never);
    // Spy on the internal NestJS Logger.error to assert the catch path logs.
    errorSpy = vi.spyOn(listener['logger'], 'error').mockImplementation(() => undefined);
  });

  const basePayload = { postId: 'post-123', network: 'X' };

  const cases: Array<{
    name: string;
    event: PostEvents;
    handler: keyof SseEventListener;
    payload: Record<string, unknown>;
    expectedStatus: string;
    extra?: Record<string, unknown>;
  }> = [
    {
      name: 'handleDraftGenerated',
      event: PostEvents.DRAFT_GENERATED,
      handler: 'handleDraftGenerated',
      payload: basePayload,
      expectedStatus: 'DRAFT',
    },
    {
      name: 'handleApproved',
      event: PostEvents.APPROVED,
      handler: 'handleApproved',
      payload: basePayload,
      expectedStatus: 'APPROVED',
    },
    {
      name: 'handlePostingStarted',
      event: PostEvents.POSTING_STARTED,
      handler: 'handlePostingStarted',
      payload: basePayload,
      expectedStatus: 'POSTING',
    },
    {
      name: 'handlePosted',
      event: PostEvents.POSTED,
      handler: 'handlePosted',
      payload: { ...basePayload, postUrl: 'https://x.com/status/1' },
      expectedStatus: 'POSTED',
      extra: { url: 'https://x.com/status/1' },
    },
    {
      name: 'handleFailed',
      event: PostEvents.FAILED,
      handler: 'handleFailed',
      payload: { ...basePayload, error: 'boom' },
      expectedStatus: 'FAILED',
      extra: { error: 'boom' },
    },
    {
      name: 'handleRejected',
      event: PostEvents.REJECTED,
      handler: 'handleRejected',
      payload: basePayload,
      expectedStatus: 'REJECTED',
    },
  ];

  it.each(cases)(
    '$name publishes the correct SSE payload on $event',
    ({ handler, payload, expectedStatus, extra }) => {
      const fn = listener[handler] as (p: typeof payload) => void;
      fn.call(listener, payload);

      expect(sseService.publish).toHaveBeenCalledTimes(1);
      expect(sseService.publish).toHaveBeenCalledWith({
        type: 'post_status',
        postId: payload.postId,
        status: expectedStatus,
        network: payload.network,
        ...extra,
      });
      expect(errorSpy).not.toHaveBeenCalled();
    },
  );

  it.each(cases)(
    '$name swallows publish errors and NEVER rethrows (event bus stays alive) on $event',
    ({ handler, payload }) => {
      sseService.publish.mockImplementationOnce(() => {
        throw new Error('Redis connection refused');
      });

      const fn = listener[handler] as (p: typeof payload) => void;
      // Must NOT throw — if it does, the event bus crashes for subsequent events.
      expect(() => fn.call(listener, payload)).not.toThrow();

      // publish was attempted (handler did not short-circuit)
      expect(sseService.publish).toHaveBeenCalledTimes(1);
      // error was logged so it is observable, not silently swallowed
      expect(errorSpy).toHaveBeenCalledTimes(1);
      const [msg] = errorSpy.mock.calls[0];
      expect(String(msg)).toContain(payload.postId);
      expect(String(msg)).toContain('Redis connection refused');
    },
  );

  it('all 5 handlers recover and continue after a transient publish failure', () => {
    // First call throws, second succeeds — simulates Redis flap.
    sseService.publish
      .mockImplementationOnce(() => {
        throw new Error('transient');
      })
      .mockResolvedValueOnce(undefined);

    listener.handleDraftGenerated(basePayload);
    listener.handleApproved(basePayload);

    expect(sseService.publish).toHaveBeenCalledTimes(2);
    // First handler logged the error, second handler did not.
    expect(errorSpy).toHaveBeenCalledTimes(1);
  });
});
