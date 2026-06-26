import { Injectable, Logger, type OnModuleDestroy } from '@nestjs/common';
import type { Response } from 'express';
import { ConfigService } from '@nestjs/config';
import IORedis from 'ioredis';

/**
 * SSE (Server-Sent Events) service — pushes real-time post status updates to UI.
 *
 * Architecture: BullMQ worker emits events to Redis Pub/Sub channel "spa:sse".
 * This service subscribes and forwards to connected SSE clients.
 *
 * Event format: { type: 'post_status', postId, status, network, url?, error? }
 *
 * UI connects: GET /events/sse → text/event-stream
 */
@Injectable()
export class SseService implements OnModuleDestroy {
  private readonly logger = new Logger(SseService.name);
  private readonly redisUrl: string;
  private readonly channel: string;
  private redis: IORedis | null = null; // subscriber connection
  private publisher: IORedis | null = null; // separate publisher connection
  private readonly clients = new Map<string, Response>();

  constructor(private readonly configService: ConfigService) {
    this.redisUrl = this.configService.get<string>('REDIS_URL', 'redis://localhost:6381');
    this.channel = this.configService.get<string>('SSE_CHANNEL', 'spa:sse');
  }

  async init(): Promise<void> {
    // Subscriber connection — enters subscriber mode, cannot publish
    this.redis = new IORedis(this.redisUrl, { maxRetriesPerRequest: null });
    await this.redis.subscribe(this.channel);
    this.redis.on('message', (_channel, message) => {
      this.broadcast(message);
    });

    // Publisher connection — separate connection for PUBLISH commands
    this.publisher = new IORedis(this.redisUrl, { maxRetriesPerRequest: null });

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
   */
  private broadcast(message: string): void {
    for (const [clientId, res] of this.clients) {
      try {
        res.write(`data: ${message}\n\n`);
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

    // Disconnect Redis connections
    this.redis?.disconnect();
    this.publisher?.disconnect();
    this.logger.log('SSE service shut down — Redis connections closed');
  }
}
