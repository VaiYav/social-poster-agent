/**
 * Sprint O: SSE Event Listener — bridges EDA domain events to SSE.
 *
 * Listens to PostEvents emitted by PostsService and publishes them to the
 * SSE endpoint so the UI gets real-time updates via the event bus instead
 * of direct SseService calls scattered across services.
 *
 * This is additive — services can still call SseService directly for
 * events that need custom payloads. The listener handles the standard
 * post lifecycle events.
 */
import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { SseService } from '../../infrastructure/sse/sse.service';
import { PostEvents, OrchestratorEvents } from '../enums/post-events.enum';

@Injectable()
export class SseEventListener {
  private readonly logger = new Logger(SseEventListener.name);

  constructor(private readonly sseService: SseService) {}

  /**
   * Publish a standard post lifecycle event to SSE.
   * Optional extra fields (url, error, retryable) are forwarded when present.
   * NEVER rethrow — the event bus must continue.
   */
  private async publishPostStatus(
    status: string,
    payload: { postId: string; network: string; postUrl?: string; error?: string; retryable?: boolean },
  ): Promise<void> {
    try {
      await this.sseService.publish({
        type: 'post_status',
        status,
        postId: payload.postId,
        network: payload.network,
        url: payload.postUrl,
        error: payload.error,
        retryable: payload.retryable,
      });
    } catch (err) {
      this.logger.error(
        `SSE publish failed for ${payload.postId} (${status}): ${(err as Error).message}`,
      );
      // NEVER rethrow — event bus must continue
    }
  }

  @OnEvent(PostEvents.DRAFT_GENERATED)
  async handleDraftGenerated(payload: { postId: string; network: string }): Promise<void> {
    return this.publishPostStatus('DRAFT', payload);
  }

  @OnEvent(PostEvents.APPROVED)
  async handleApproved(payload: { postId: string; network: string }): Promise<void> {
    return this.publishPostStatus('APPROVED', payload);
  }

  @OnEvent(PostEvents.POSTING_STARTED)
  async handlePostingStarted(payload: { postId: string; network: string }): Promise<void> {
    return this.publishPostStatus('POSTING', payload);
  }

  @OnEvent(PostEvents.POSTED)
  async handlePosted(payload: { postId: string; network: string; postUrl?: string }): Promise<void> {
    return this.publishPostStatus('POSTED', payload);
  }

  @OnEvent(PostEvents.FAILED)
  async handleFailed(payload: { postId: string; network: string; error?: string; retryable?: boolean }): Promise<void> {
    return this.publishPostStatus('FAILED', payload);
  }

  @OnEvent(PostEvents.REJECTED)
  async handleRejected(payload: { postId: string; network: string }): Promise<void> {
    return this.publishPostStatus('REJECTED', payload);
  }

  @OnEvent(OrchestratorEvents.CYCLE_END)
  async handleOrchestratorCycleEnd(payload: {
    cycle: number;
    action?: string;
    success?: boolean;
    duration?: number;
    sleepMs: number;
  }): Promise<void> {
    try {
      await this.sseService.publish({
        type: 'orchestrator_cycle_end',
        cycle: payload.cycle,
        action: payload.action,
        success: payload.success,
        duration: payload.duration,
        sleepMs: payload.sleepMs,
      });
    } catch (err) {
      this.logger.error(
        `SSE publish failed for orchestrator cycle ${payload.cycle}: ${(err as Error).message}`,
      );
    }
  }
}
