import { Injectable, Logger, type OnModuleInit, type OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Queue, Worker, type Job } from 'bullmq';

/**
 * BullMQ queue factory — creates Redis-backed queues and workers for posting.
 *
 * Queues (one per network for concurrency=1 isolation — B9 mitigation):
 * - spa-posting-x
 * - spa-posting-threads
 * - spa-posting-facebook
 *
 * Retry config (CONSTITUTION §8):
 * - Max retries: 3 (env: BULLMQ_MAX_RETRIES)
 * - Backoff: exponential, base delay 60s (env: BULLMQ_RETRY_DELAY_MS)
 * - 1min → 5min → 15min
 *
 * Dead-letter: BullMQ 'failed' queue retains jobs for manual intervention.
 */
@Injectable()
export class QueueFactory implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(QueueFactory.name);
  private readonly redisUrl: string;
  private readonly maxRetries: number;
  private readonly retryDelayMs: number;
  private readonly queuePrefix: string;
  private readonly concurrency: number;

  // Queue instances per network
  private readonly queues = new Map<string, Queue>();

  // Worker instances per network
  private readonly workers = new Map<string, Worker>();

  constructor(private readonly configService: ConfigService) {
    this.redisUrl = this.configService.get<string>('REDIS_URL', 'redis://localhost:6381');
    this.maxRetries = this.configService.get<number>('BULLMQ_MAX_RETRIES', 3);
    this.retryDelayMs = this.configService.get<number>('BULLMQ_RETRY_DELAY_MS', 60000);
    this.queuePrefix = this.configService.get<string>('BULLMQ_QUEUE_PREFIX', 'spa');
    this.concurrency = Number(this.configService.get<string>('BULLMQ_CONCURRENCY_PER_QUEUE')) || 1;
  }

  onModuleInit(): void {
    this.logger.log(
      `BullMQ configured for Redis (${this.redisUrl}, prefix=${this.queuePrefix}, retries=${this.maxRetries})`,
    );
  }

  async onModuleDestroy(): Promise<void> {
    for (const worker of this.workers.values()) {
      await worker.close();
    }
    for (const queue of this.queues.values()) {
      await queue.close();
    }
    this.logger.log('BullMQ queues and workers closed');
  }

  private getConnectionOpts() {
    return { connection: { url: this.redisUrl } };
  }

  /**
   * Get or create a queue for a specific network and action.
   * Queue name: {prefix}:{action}-{network}
   * action: 'posting' or 'engagement'
   */
  getQueue(network: string, action: 'posting' | 'engagement' = 'posting'): Queue {
    const queueName = `${this.queuePrefix}-${action}-${network.toLowerCase()}`;
    let queue = this.queues.get(queueName);
    if (!queue) {
      queue = new Queue(queueName, this.getConnectionOpts());
      this.queues.set(queueName, queue);
    }
    return queue;
  }

  /**
   * Enqueue a posting job for a specific post.
   * Job ID = postId for idempotency (BullMQ deduplicates by jobId).
   */
  async enqueuePosting(postId: string, network: string): Promise<void> {
    const queue = this.getQueue(network, 'posting');
    await queue.add(
      'post',
      { postId, network },
      {
        jobId: postId, // idempotent — won't create duplicate jobs
        attempts: this.maxRetries,
        backoff: {
          type: 'exponential',
          delay: this.retryDelayMs,
        },
        removeOnComplete: { count: 100 },
        removeOnFail: { count: 500 },
      },
    );
    this.logger.log(`Enqueued posting job for post ${postId} → ${network}`);
  }

  /**
   * Enqueue an engagement job (like, comment, follow, browsing session).
   * Job ID = interactionId or browsingSessionId for idempotency.
   */
  async enqueueEngagement(
    interactionId: string,
    network: string,
    action: 'like' | 'comment' | 'follow' | 'reply' | 'browsing-session',
    payload: Record<string, unknown>,
  ): Promise<void> {
    const queue = this.getQueue(network, 'engagement');
    await queue.add(
      action,
      { interactionId, network, action, ...payload },
      {
        jobId: interactionId, // idempotent
        attempts: this.maxRetries,
        backoff: {
          type: 'exponential',
          delay: this.retryDelayMs,
        },
        removeOnComplete: { count: 100 },
        removeOnFail: { count: 500 },
      },
    );
    this.logger.log(`Enqueued ${action} job ${interactionId} → ${network}`);
  }

  /**
   * Retry a failed job by moving it back to the waiting state.
   */
  async retryFailedJob(network: string, jobId: string): Promise<void> {
    const queue = this.getQueue(network, 'posting');
    const job = await queue.getJob(jobId);
    if (!job) {
      throw new Error(`Job ${jobId} not found in ${network} queue`);
    }
    if (job.failedReason) {
      await job.retry();
      this.logger.log(`Retrying failed job ${jobId} in ${network} queue`);
    } else {
      throw new Error(`Job ${jobId} is not in failed state`);
    }
  }

  /**
   * Schedule a posting job for a specific time.
   */
  async schedulePosting(
    postId: string,
    network: string,
    scheduledAt: Date,
  ): Promise<void> {
    const queue = this.getQueue(network, 'posting');
    const delayMs = scheduledAt.getTime() - Date.now();
    if (delayMs <= 0) {
      // Schedule time is in the past — enqueue immediately
      return this.enqueuePosting(postId, network);
    }
    await queue.add(
      'post',
      { postId, network },
      {
        jobId: postId,
        delay: delayMs,
        attempts: this.maxRetries,
        backoff: {
          type: 'exponential',
          delay: this.retryDelayMs,
        },
        removeOnComplete: { count: 100 },
        removeOnFail: { count: 500 },
      },
    );
    this.logger.log(`Scheduled posting job for post ${postId} → ${network} at ${scheduledAt.toISOString()}`);
  }

  /**
   * Register a worker for a specific network queue.
   * Called by QueueModule on bootstrap.
   */
  registerWorker(
    network: string,
    handler: (job: Job) => Promise<void>,
    action: 'posting' | 'engagement' = 'posting',
  ): Worker {
    const queueName = `${this.queuePrefix}-${action}-${network.toLowerCase()}`;
    let worker = this.workers.get(queueName);
    if (worker) {
      this.logger.warn(`Worker for ${queueName} already registered`);
      return worker;
    }

    worker = new Worker(queueName, handler, {
      ...this.getConnectionOpts(),
      concurrency: this.concurrency,
    });

    worker.on('completed', (job) => {
      this.logger.log(`Job ${job.id} completed (${queueName})`);
    });

    worker.on('failed', (job, err) => {
      this.logger.error(
        `Job ${job?.id} failed (${queueName}): ${err.message} (attempts: ${job?.attemptsMade}/${this.maxRetries})`,
      );
    });

    worker.on('stalled', (jobId) => {
      this.logger.warn(`Job ${jobId} stalled (${queueName}) — will be retried`);
    });

    this.workers.set(queueName, worker);
    this.logger.log(`Worker registered for ${queueName} (concurrency=${this.concurrency})`);
    return worker;
  }

  /**
   * Get failed jobs (dead-letter queue) for a network.
   */
  async getFailedJobs(network: string, action: 'posting' | 'engagement' = 'posting') {
    const queue = this.getQueue(network, action);
    return queue.getFailed();
  }

  /**
   * Get active/waiting job counts for a network.
   */
  async getJobCounts(network: string, action: 'posting' | 'engagement' = 'posting') {
    const queue = this.getQueue(network, action);
    return queue.getJobCounts('waiting', 'active', 'completed', 'failed', 'delayed');
  }
}
