import { Injectable, Logger, Inject, type OnModuleDestroy } from '@nestjs/common';
import type { Response } from 'express';
import { ConfigService } from '@nestjs/config';
import IORedis from 'ioredis';
import { SHARED_REDIS_SUBSCRIBER, SHARED_REDIS_PUBLISHER } from '../redis/redis.module.js';

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
  private readonly clients = new Map<string, Response>();

  constructor(
    private readonly configService: ConfigService,
    @Inject(SHARED_REDIS_SUBSCRIBER) private readonly redis: IORedis,
    @Inject(SHARED_REDIS_PUBLISHER) private readonly publisher: IORedis,
  ) {
    this.channel = this.configService.get<string>('SSE_CHANNEL', 'spa:sse');
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
  addClient(res: Response): string {
    const clientId = `sse-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    this.clients.set(clientId, res);
    this.logger.debug(`SSE client connected: ${clientId} (total: ${this.clients.size})`);

    // Send initial heartbeat
    res.write(`data: ${JSON.stringify({ type: 'connected', clientId })}\n\n`);

    return clientId;
  }

  removeClient(clientId: string): void {
    this.clients.delete(clientId);
    this.logger.debug(`SSE client disconnected: ${clientId} (total: ${this.clients.size})`);
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
      } catch {
        // Client disconnected — remove
        this.removeClient(clientId);
      }
    }
  }

  /**
   * Publish an event to Redis (called by workers/services).
   */
  async publish(event: {
    type: string;
    postId?: string;
    status?: string;
    network?: string;
    url?: string;
    error?: string;
    sessionId?: string;
    interactionId?: string;
    interactionType?: string;
    targetUrl?: string;
    durationSec?: number;
    postsViewed?: number;
    interactionsCount?: number;
    severity?: string; // P1-6: health_alert severity ('critical' | 'warning' | 'info')
    commentId?: string; // Sprint Q: reply_posted event
    // Sprint I: Generation progress events
    runId?: string;
    node?: string;
    topic?: string;
    postsCount?: number;
    postCount?: number;
    count?: number;
    // Sprint Q: Replies monitor events
    postsChecked?: number;
    commentsScraped?: number;
    repliesPosted?: number;
    humanReview?: number;
    // ADR-006: Autonomy & flow control events
    action?: string;
    flow?: string;
    reason?: string | null;
    decision?: string;
    qualityScore?: number | null;
    generated?: number;
    autoApproved?: number;
    rejected?: number;
    pauseAll?: boolean;
    flows?: Record<string, boolean>;
    // Orchestrator events
    cycle?: number;
    sleepMs?: number;
    success?: boolean;
    duration?: number;
  }): Promise<void> {
    if (!this.publisher) return;
    await this.publisher.publish(this.channel, JSON.stringify(event));
  }

  getConnectedCount(): number {
    return this.clients.size;
  }

  onModuleDestroy(): void {
    // Close all SSE client connections
    for (const [, res] of this.clients) {
      try {
        res.end();
      } catch {
        // ignore — client may already be closed
      }
    }
    this.clients.clear();

    // Sprint L: Redis connections are managed by RedisModule — don't close here
    // Just unsubscribe from the channel
    this.redis?.unsubscribe(this.channel).catch(() => {});
    this.logger.log('SSE service shut down — unsubscribed from Redis channel');
  }
}
