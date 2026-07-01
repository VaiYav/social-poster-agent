/**
 * OrchestratorService — lifecycle management for the LangGraph orchestrator loop.
 *
 * Compiles the orchestrator graph with RedisCheckpointSaver and runs it
 * continuously. The graph cycles: OBSERVE → DECIDE → EXECUTE → EVALUATE → loop.
 *
 * Crash-resume: state is checkpointed to Redis. On restart, the graph resumes
 * from the last checkpoint (thread_id = "orchestrator").
 *
 * Adaptive sleep: between cycles, the graph sleeps for a calculated duration
 * (15s recovery, 60s active, 120s idle, 600s night). A heartbeat is written
 * to Redis before every sleep so the watchdog can detect hangs.
 */

import { Injectable, Logger, OnModuleInit, OnModuleDestroy, Inject, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { SHARED_REDIS } from '../../infrastructure/redis/redis.module.js';
import { RedisCheckpointSaver } from '../../infrastructure/checkpoint/redis-checkpoint.js';
import { parseBool } from '../../infrastructure/config/parse-bool.js';
import { StateCollectorService } from './state-collector.service.js';
import { DecisionEngineService } from './decision-engine.service.js';
import { ActionExecutorService } from './action-executor.service.js';
import { OrchestratorHistoryService } from './orchestrator-history.service.js';
import { buildOrchestratorGraph, createInitialOrchestratorState } from './orchestrator.graph.js';
import type { OrchestratorStateType } from './orchestrator.graph.js';
import type { CompiledStateGraph } from '@langchain/langgraph';
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyCompiledGraph = CompiledStateGraph<any, any>;
import type { ActionResult } from './types.js';
import { OrchestratorEvents } from '../../events/enums/post-events.enum.js';

const THREAD_ID = 'orchestrator';
const HEARTBEAT_KEY_DEFAULT = 'spa:orchestrator:heartbeat';
const HEARTBEAT_TTL_MS_DEFAULT = 600_000;
const CHECKPOINT_KEY_PREFIX = 'checkpoint:orchestrator';

@Injectable()
export class OrchestratorService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(OrchestratorService.name);
  private readonly enabled: boolean;
  private readonly heartbeatKey: string;
  private readonly heartbeatTtlMs: number;

  private running = false;
  private stopRequested = false;
  private graphPromise: Promise<void> | null = null;
  private sleepAbort: AbortController | null = null;
  private currentCycle = 0;

  // Mutex to prevent concurrent start/stop/restart (watchdog + API race)
  private lifecycleLock = false;

  constructor(
    private readonly configService: ConfigService,
    @Inject(SHARED_REDIS) private readonly redis: InstanceType<typeof import('ioredis').default>,
    private readonly stateCollector: StateCollectorService,
    private readonly decisionEngine: DecisionEngineService,
    private readonly actionExecutor: ActionExecutorService,
    private readonly historyService: OrchestratorHistoryService,
    @Optional() private readonly checkpointSaver: RedisCheckpointSaver,
    @Optional() private readonly eventEmitter: EventEmitter2,
  ) {
    this.enabled = parseBool(this.configService.get<string>('ORCHESTRATOR_ENABLED') ?? 'false');
    this.heartbeatKey = this.configService.get<string>('ORCHESTRATOR_HEARTBEAT_KEY') ?? HEARTBEAT_KEY_DEFAULT;
    this.heartbeatTtlMs = Number(this.configService.get<string>('ORCHESTRATOR_HEARTBEAT_TTL_MS') ?? HEARTBEAT_TTL_MS_DEFAULT);
  }

  onModuleInit() {
    if (this.enabled) {
      void this.start();
    }
  }

  async onModuleDestroy() {
    await this.stop();
  }

  async start(): Promise<void> {
    if (this.lifecycleLock) {
      this.logger.warn('Lifecycle operation in progress — start skipped');
      return;
    }
    if (this.running) {
      this.logger.warn('Orchestrator already running');
      return;
    }

    this.lifecycleLock = true;
    try {
      this.running = true;
      this.stopRequested = false;
      this.currentCycle = 0;
      this.logger.log('Orchestrator starting...');

      // Build graph dependencies
      const deps = {
        stateCollector: this.stateCollector,
        decisionEngine: this.decisionEngine,
        actionExecutor: this.actionExecutor,
        writeHeartbeat: () => this.writeHeartbeat(),
        sleep: (ms: number) => this.sleep(ms),
        isStopped: () => this.stopRequested,
        onCycleEnd: (cycle: number, result: ActionResult | null, sleepMs: number) =>
          this.onCycleEnd(cycle, result, sleepMs),
      };

      // Build and compile graph
      const graphBuilder = buildOrchestratorGraph(deps);
      const compileOpts: { checkpointer?: RedisCheckpointSaver } = {};
      if (this.checkpointSaver) {
        compileOpts.checkpointer = this.checkpointSaver;
      }
      const compiledGraph = graphBuilder.compile(compileOpts) as AnyCompiledGraph;

      // Run graph in background
      this.graphPromise = this.runGraphLoop(compiledGraph);

      this.logger.log('Orchestrator started');
    } finally {
      this.lifecycleLock = false;
    }
  }

  async stop(): Promise<void> {
    if (this.lifecycleLock) {
      this.logger.warn('Lifecycle operation in progress — stop skipped');
      return;
    }
    if (!this.running) return;

    this.lifecycleLock = true;
    try {
      this.stopRequested = true;
      this.logger.log('Orchestrator stop requested...');

      // Abort any in-progress sleep
      this.sleepAbort?.abort();

      // Wait for graph to exit (should happen within current sleep cycle)
      if (this.graphPromise) {
        await Promise.race([
          this.graphPromise,
          new Promise((r) => setTimeout(r, 10_000)), // max 10s wait
        ]).catch(() => void 0);
      }

      this.running = false;
      this.graphPromise = null;
      this.logger.log('Orchestrator stopped');
    } finally {
      this.lifecycleLock = false;
    }
  }

  isRunning(): boolean {
    return this.running;
  }

  /**
   * Reset checkpoint — allows a fresh start without resuming old state.
   * Deletes the Redis checkpoint key for the orchestrator thread.
   */
  async resetCheckpoint(): Promise<void> {
    try {
      // RedisCheckpointSaver stores under a prefix; delete all matching keys
      const keys = await this.redis.keys(`${CHECKPOINT_KEY_PREFIX}*`);
      if (keys.length > 0) {
        await this.redis.del(...keys);
        this.logger.log(`Checkpoint reset — deleted ${keys.length} key(s)`);
      }
    } catch (err) {
      this.logger.warn(`Checkpoint reset failed: ${(err as Error).message}`);
    }
  }

  // ── Graph Loop ───────────────────────────────────────────────────────────

  private async runGraphLoop(compiledGraph: AnyCompiledGraph): Promise<void> {
    let state = createInitialOrchestratorState();

    // Try to resume from checkpoint
    try {
      const checkpoint = await this.checkpointSaver?.getTuple({
        configurable: { thread_id: THREAD_ID },
      });
      if (checkpoint) {
        this.logger.log('Resuming orchestrator from checkpoint');
      }
    } catch {
      this.logger.warn('Failed to load checkpoint, starting fresh');
    }

    while (!this.stopRequested) {
      try {
        const result = await compiledGraph.invoke(state, {
          configurable: { thread_id: THREAD_ID },
        });

        state = result as OrchestratorStateType;
        this.currentCycle = state.cycle;
      } catch (err) {
        this.logger.error(`Orchestrator cycle error: ${(err as Error).message}`);
        await this.sleep(60_000);
      }
    }

    this.logger.log('Orchestrator loop exited');
  }

  // ── Heartbeat ────────────────────────────────────────────────────────────

  private async writeHeartbeat(): Promise<void> {
    try {
      await this.redis.set(this.heartbeatKey, String(Date.now()), 'PX', this.heartbeatTtlMs);
    } catch (err) {
      this.logger.warn(`Failed to write heartbeat: ${(err as Error).message}`);
    }
  }

  // ── Sleep (interruptible via AbortController) ─────────────────────────────

  private async sleep(ms: number): Promise<void> {
    this.sleepAbort = new AbortController();
    const signal = this.sleepAbort.signal;

    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        signal.removeEventListener('abort', onAbort);
        resolve();
      }, ms);

      const onAbort = () => {
        clearTimeout(timer);
        resolve();
      };

      if (signal.aborted) {
        clearTimeout(timer);
        resolve();
      } else {
        signal.addEventListener('abort', onAbort, { once: true });
      }
    });

    this.sleepAbort = null;
  }

  // ── Cycle Callbacks ──────────────────────────────────────────────────────

  private onCycleEnd(cycle: number, result: ActionResult | null, sleepMs: number): void {
    this.logger.debug(`Cycle ${cycle} ended: ${result?.type ?? 'N/A'} (sleep ${sleepMs}ms)`);

    void this.historyService.record(cycle, result, sleepMs);

    // Emit domain event — SseEventListener bridges to SSE
    if (this.eventEmitter) {
      this.eventEmitter.emit(OrchestratorEvents.CYCLE_END, {
        cycle,
        action: result?.type,
        success: result?.success,
        duration: result?.duration,
        sleepMs,
      });
    }
  }

  // ── Status (for REST API) ────────────────────────────────────────────────

  async getStatus(): Promise<{
    enabled: boolean;
    running: boolean;
    cycle: number;
    heartbeat: number | null;
    heartbeatAgeMs: number | null;
  }> {
    let heartbeat: number | null = null;
    let heartbeatAgeMs: number | null = null;

    try {
      const hb = await this.redis.get(this.heartbeatKey);
      if (hb) {
        heartbeat = Number(hb);
        heartbeatAgeMs = Date.now() - heartbeat;
      }
    } catch {
      // Redis error
    }

    return {
      enabled: this.enabled,
      running: this.running,
      cycle: this.currentCycle,
      heartbeat,
      heartbeatAgeMs,
    };
  }

  async getHistory(limit = 50): Promise<Record<string, unknown>[]> {
    return this.historyService.getHistory(limit);
  }
}
