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

  @OnEvent(PostEvents.DRAFT_GENERATED)
  handleDraftGenerated(payload: { postId: string; network: string }): void {
    try {
      this.sseService.publish({
        type: 'post_status',
        postId: payload.postId,
        status: 'DRAFT',
        network: payload.network,
      });
    } catch (err) {
      this.logger.error(
        `SSE publish failed for ${payload.postId} (DRAFT): ${(err as Error).message}`,
      );
      // NEVER rethrow — event bus must continue
    }
  }

  @OnEvent(PostEvents.APPROVED)
  handleApproved(payload: { postId: string; network: string }): void {
    try {
      this.sseService.publish({
        type: 'post_status',
        postId: payload.postId,
        status: 'APPROVED',
        network: payload.network,
      });
    } catch (err) {
      this.logger.error(
        `SSE publish failed for ${payload.postId} (APPROVED): ${(err as Error).message}`,
      );
      // NEVER rethrow — event bus must continue
    }
  }

  @OnEvent(PostEvents.POSTING_STARTED)
  handlePostingStarted(payload: { postId: string; network: string }): void {
    try {
      this.sseService.publish({
        type: 'post_status',
        postId: payload.postId,
        status: 'POSTING',
        network: payload.network,
      });
    } catch (err) {
      this.logger.error(
        `SSE publish failed for ${payload.postId} (POSTING): ${(err as Error).message}`,
      );
      // NEVER rethrow — event bus must continue
    }
  }

  @OnEvent(PostEvents.POSTED)
  handlePosted(payload: { postId: string; network: string; postUrl?: string }): void {
    try {
      this.sseService.publish({
        type: 'post_status',
        postId: payload.postId,
        status: 'POSTED',
        network: payload.network,
        url: payload.postUrl,
      });
    } catch (err) {
      this.logger.error(
        `SSE publish failed for ${payload.postId} (POSTED): ${(err as Error).message}`,
      );
      // NEVER rethrow — event bus must continue
    }
  }

  @OnEvent(PostEvents.FAILED)
  handleFailed(payload: { postId: string; network: string; error?: string }): void {
    try {
      this.sseService.publish({
        type: 'post_status',
        postId: payload.postId,
        status: 'FAILED',
        network: payload.network,
        error: payload.error,
      });
    } catch (err) {
      this.logger.error(
        `SSE publish failed for ${payload.postId} (FAILED): ${(err as Error).message}`,
      );
      // NEVER rethrow — event bus must continue
    }
  }

  @OnEvent(OrchestratorEvents.CYCLE_END)
  handleOrchestratorCycleEnd(payload: {
    cycle: number;
    action?: string;
    success?: boolean;
    duration?: number;
    sleepMs: number;
  }): void {
    try {
      this.sseService.publish({
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
