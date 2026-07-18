import { Injectable, Logger, Inject, type OnModuleDestroy } from '@nestjs/common';
import type { Response } from 'express';
import { ConfigService } from '@nestjs/config';
import IORedis from 'ioredis';
import {
  SSEventSchema,
  type SSEvent,
  type SseMetricsSnapshotEvent,
  type SsePostStatusEvent,
  type SseHealthAlertEvent,
  type SseGenerationStartedEvent,
  type SseGenerationProgressEvent,
  type SseGenerationCompletedEvent,
  type SseGenerationFailedEvent,
  type SseGenerationPausedEvent,
  type SseGenerationResumedEvent,
  type SseInteractionEvent,
  type SseBrowsingSessionStartedEvent,
  type SseBrowsingSessionCompletedEvent,
  type SseBrowsingSessionFailedEvent,
  type SseRepliesMonitorEvent,
  type SseReplyPostedEvent,
  type SseReconciliationRequeueEvent,
  type SseAutoApproveEvent,
  type SseAutonomousCycleEvent,
  type SseOrchestratorCycleEndEvent,
  type SseFlowControlEvent,
} from '@spa/shared';
import { SHARED_REDIS_SUBSCRIBER, SHARED_REDIS_PUBLISHER } from '../redis/redis.module.js';

// Re-export SSE event types and schema from the shared package for backend consumers.
export type {
  SSEvent as SseEvent,
  SseMetricsSnapshotEvent,
  SsePostStatusEvent,
  SseHealthAlertEvent,
  SseGenerationStartedEvent,
  SseGenerationProgressEvent,
  SseGenerationCompletedEvent,
  SseGenerationFailedEvent,
  SseGenerationPausedEvent,
  SseGenerationResumedEvent,
  SseInteractionEvent,
  SseBrowsingSessionStartedEvent,
  SseBrowsingSessionCompletedEvent,
  SseBrowsingSessionFailedEvent,
  SseRepliesMonitorEvent,
  SseReplyPostedEvent,
  SseReconciliationRequeueEvent,
  SseAutoApproveEvent,
  SseAutonomousCycleEvent,
  SseOrchestratorCycleEndEvent,
  SseFlowControlEvent,
};

export { SSEventSchema };

/**
 * SSE (Server-Sent Events) service — pushes real-time post status updates to UI.
 *
 * Architecture: BullMQ worker emits events to Redis Pub/Sub channel "spa:sse".
 * This service subscribes and forwards to connected SSE clients.
 *
 * Event format: { type: 'post_status', postId, status, network, url?, error? }
 *
 * UI connects: GET /events/sse → text/event-stream
 *
 * Sprint L: Uses shared Redis connections from RedisModule instead of creating
 * separate connections. Reduces total TCP connections to Redis.
 */
@Injectable()
export class SseService implements OnModuleDestroy {
  private readonly logger = new Logger(SseService.name);
  private readonly channel: string;
  private readonly maxConnectionsPerIp: number;
  private readonly idleTimeoutMs: number;
  private readonly clients = new Map<string, Response>();
  private readonly clientIps = new Map<string, string>();
  private readonly idleTimers = new Map<string, NodeJS.Timeout>();

  constructor(
    private readonly configService: ConfigService,
    @Inject(SHARED_REDIS_SUBSCRIBER) private readonly redis: IORedis,
    @Inject(SHARED_REDIS_PUBLISHER) private readonly publisher: IORedis,
  ) {
    this.channel = this.configService.get<string>('SSE_CHANNEL', 'spa:sse');
    this.maxConnectionsPerIp = this.configService.get<number>('SSE_MAX_CONNECTIONS_PER_IP', 10);
    this.idleTimeoutMs = this.configService.get<number>('SSE_IDLE_TIMEOUT_MS', 5 * 60 * 1000);
  }

  async init(): Promise<void> {
    // Subscriber connection — enters subscriber mode, cannot publish
    // Sprint L: Uses shared subscriber connection from RedisModule
    await this.redis.subscribe(this.channel);
    this.redis.on('message', (_channel, message) => {
      this.broadcast(message);
    });

    this.logger.log(`SSE subscribed to Redis channel "${this.channel}"`);
  }

  /**
   * Add a new SSE client connection.
   * Returns a client ID for cleanup.
   */
  addClient(res: Response, ip?: string): string | null {
    if (ip) {
      const countForIp = Array.from(this.clientIps.values()).filter((v) => v === ip).length;
      if (countForIp >= this.maxConnectionsPerIp) {
        this.logger.warn(`SSE per-IP limit (${this.maxConnectionsPerIp}) reached for ${ip} — rejecting connection`);
        try { res.end(); } catch { /* ignore */ }
        return null;
      }
    }

    const clientId = `sse-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    this.clients.set(clientId, res);
    if (ip) this.clientIps.set(clientId, ip);
    this.resetIdleTimer(clientId, res);
    this.logger.debug(`SSE client connected: ${clientId} (total: ${this.clients.size})`);

    // Send initial heartbeat
    res.write(`data: ${JSON.stringify({ type: 'connected', clientId })}\n\n`);

    return clientId;
  }

  removeClient(clientId: string): void {
    const timer = this.idleTimers.get(clientId);
    if (timer) {
      clearTimeout(timer);
      this.idleTimers.delete(clientId);
    }
    this.clients.delete(clientId);
    this.clientIps.delete(clientId);
    this.logger.debug(`SSE client disconnected: ${clientId} (total: ${this.clients.size})`);
  }

  /**
   * Reset the idle timeout for a client. Called by the controller heartbeat
   * and by successful broadcast writes.
   */
  touchClient(clientId: string): void {
    const res = this.clients.get(clientId);
    if (res) this.resetIdleTimer(clientId, res);
  }

  private resetIdleTimer(clientId: string, res: Response): void {
    const existing = this.idleTimers.get(clientId);
    if (existing) clearTimeout(existing);

    const timer = setTimeout(() => {
      this.logger.warn(`SSE client ${clientId} idle for ${this.idleTimeoutMs}ms — closing`);
      this.removeClient(clientId);
      try { res.end(); } catch { /* ignore */ }
    }, this.idleTimeoutMs);

    this.idleTimers.set(clientId, timer);
  }

  /**
   * Broadcast a message to all connected SSE clients.
   *
   * Sprint L: Backpressure handling — if res.write returns false (buffer full),
   * wait for 'drain' event before continuing. Removes clients that have ended.
   */
  private broadcast(message: string): void {
    for (const [clientId, res] of this.clients) {
      try {
        // Sprint L: Check if response has ended — remove stale clients
        if (res.writableEnded) {
          this.removeClient(clientId);
          continue;
        }

        const canWrite = res.write(`data: ${message}\n\n`);
        if (!canWrite) {
          // Backpressure — buffer is full, wait for drain
          this.logger.debug(`Backpressure on client ${clientId} — waiting for drain`);
          res.once('drain', () => {
            // Client recovered — no action needed
          });
          // Set a timeout to remove the client if it doesn't drain within 5s
          setTimeout(() => {
            if (!res.destroyed && !res.writableEnded) {
              this.logger.warn(`Client ${clientId} stalled (backpressure timeout) — removing`);
              this.removeClient(clientId);
              try { res.end(); } catch { /* ignore */ }
            }
          }, 5000);
        }

        // Reset idle timeout for any client we are still tracking
        if (this.clients.has(clientId)) this.touchClient(clientId);
      } catch {
        // Client disconnected — remove
        this.removeClient(clientId);
      }
    }
  }

  /**
   * Publish an event to Redis (called by workers/services).
   * Fire-and-forget safe: Redis errors are caught and logged, never thrown to callers.
   */
  async publish(event: SSEvent): Promise<void> {
    if (!this.publisher) return;
    try {
      const validated = SSEventSchema.parse(event);
      await this.publisher.publish(this.channel, JSON.stringify(validated));
    } catch (err) {
      this.logger.error(
        `SSE publish to Redis failed: ${(err as Error).message}`,
        (err as Error).stack,
      );
      // Never throw — SSE is a best-effort notification channel.
    }
  }

  getConnectedCount(): number {
    return this.clients.size;
  }

  onModuleDestroy(): void {
    // Clear all idle timers
    for (const timer of this.idleTimers.values()) {
      clearTimeout(timer);
    }
    this.idleTimers.clear();

    // Close all SSE client connections
    for (const [clientId, res] of this.clients) {
      try {
        res.end();
      } catch {
        // ignore — client may already be closed
      }
      this.clientIps.delete(clientId);
    }
    this.clients.clear();

    // Sprint L: Redis connections are managed by RedisModule — don't close here
    // Just unsubscribe from the channel
    this.redis?.unsubscribe(this.channel).catch(() => {});
    this.logger.log('SSE service shut down — unsubscribed from Redis channel');
  }
}
