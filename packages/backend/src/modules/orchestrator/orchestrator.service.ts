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
import { SHARED_REDIS } from '../../infrastructure/redis/redis.module.js';
import { RedisCheckpointSaver } from '../../infrastructure/checkpoint/redis-checkpoint.js';
import { SseService } from '../../infrastructure/sse/sse.service.js';
import { parseBool } from '../../infrastructure/config/parse-bool.js';
import { StateCollectorService } from './state-collector.service.js';
import { DecisionEngineService } from './decision-engine.service.js';
import { ActionExecutorService } from './action-executor.service.js';
import { buildOrchestratorGraph, createInitialOrchestratorState } from './orchestrator.graph.js';
import type { OrchestratorStateType } from './orchestrator.graph.js';

const THREAD_ID = 'orchestrator';
const HEARTBEAT_KEY = process.env.ORCHESTRATOR_HEARTBEAT_KEY ?? 'spa:orchestrator:heartbeat';
const HEARTBEAT_TTL_MS = Number(process.env.ORCHESTRATOR_HEARTBEAT_TTL_MS ?? '600000');
const HISTORY_KEY = process.env.ORCHESTRATOR_HISTORY_KEY ?? 'spa:orchestrator:history';
const HISTORY_MAX = 200;

@Injectable()
export class OrchestratorService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(OrchestratorService.name);
  private readonly enabled: boolean;
  private running = false;
  private stopRequested = false;
  private graphPromise: Promise<void> | null = null;

  constructor(
    private readonly configService: ConfigService,
    @Inject(SHARED_REDIS) private readonly redis: InstanceType<typeof import('ioredis').default>,
    private readonly stateCollector: StateCollectorService,
    private readonly decisionEngine: DecisionEngineService,
    private readonly actionExecutor: ActionExecutorService,
    @Optional() private readonly checkpointSaver: RedisCheckpointSaver,
    @Optional() private readonly sseService: SseService,
  ) {
    this.enabled = parseBool(process.env.ORCHESTRATOR_ENABLED ?? 'false');
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
    if (this.running) {
      this.logger.warn('Orchestrator already running');
      return;
    }

    this.running = true;
    this.stopRequested = false;
    this.logger.log('Orchestrator starting...');

    // Build graph dependencies
    const deps = {
      stateCollector: this.stateCollector,
      decisionEngine: this.decisionEngine,
      actionExecutor: this.actionExecutor,
      orchestratorService: this,
      writeHeartbeat: () => this.writeHeartbeat(),
      sleep: (ms: number) => this.sleep(ms),
      isStopped: () => this.stopRequested,
      onCycleStart: (cycle: number, action: any) => this.onCycleStart(cycle, action),
      onCycleEnd: (cycle: number, result: any, sleepMs: number) => this.onCycleEnd(cycle, result, sleepMs),
    };

    // Build and compile graph
    const graphBuilder = buildOrchestratorGraph(deps);
    const compileOpts: any = {};
    if (this.checkpointSaver) {
      compileOpts.checkpointer = this.checkpointSaver;
    }
    const compiledGraph = graphBuilder.compile(compileOpts);

    // Run graph in background
    this.graphPromise = this.runGraphLoop(compiledGraph);

    this.logger.log('Orchestrator started');
  }

  async stop(): Promise<void> {
    if (!this.running) return;

    this.stopRequested = true;
    this.logger.log('Orchestrator stop requested...');

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
  }

  isRunning(): boolean {
    return this.running;
  }

  // ── Graph Loop ───────────────────────────────────────────────────────────

  /**
   * The graph is invoked in a loop because LangGraph's conditional edge
   * returning to a previous node creates an infinite loop that the graph
   * runtime handles. However, for long-running loops with sleeps, we use
   * a manual loop approach: invoke the graph once per cycle, then re-invoke
   * with the updated state. This gives us better control over lifecycle.
   */
  private async runGraphLoop(compiledGraph: any): Promise<void> {
    let state = createInitialOrchestratorState();

    // Try to resume from checkpoint
    try {
      const checkpoint = await this.checkpointSaver?.getTuple({
        configurable: { thread_id: THREAD_ID },
      });
      if (checkpoint) {
        this.logger.log('Resuming orchestrator from checkpoint');
        // The graph will resume from checkpoint automatically when invoked with same thread_id
      }
    } catch {
      this.logger.warn('Failed to load checkpoint, starting fresh');
    }

    while (!this.stopRequested) {
      try {
        // Invoke one full cycle: observe → decide → execute → evaluate
        const result = await compiledGraph.invoke(state, {
          configurable: { thread_id: THREAD_ID },
        });

        // Update state from result (for next cycle)
        state = result as OrchestratorStateType;

        // The evaluate node already slept, so we immediately loop back
        // If stop was requested during sleep, the loop exits
      } catch (err) {
        this.logger.error(`Orchestrator cycle error: ${(err as Error).message}`);
        // Wait before retrying to avoid tight error loop
        await this.sleep(60_000);
      }
    }

    this.logger.log('Orchestrator loop exited');
  }

  // ── Heartbeat ────────────────────────────────────────────────────────────

  private async writeHeartbeat(): Promise<void> {
    try {
      await this.redis.set(HEARTBEAT_KEY, String(Date.now()), 'PX', HEARTBEAT_TTL_MS);
    } catch (err) {
      this.logger.warn(`Failed to write heartbeat: ${(err as Error).message}`);
    }
  }

  // ── Sleep (interruptible) ────────────────────────────────────────────────

  private async sleep(ms: number): Promise<void> {
    // Sleep in 1s increments so we can detect stop requests quickly
    const remaining = ms;
    const start = Date.now();
    while (Date.now() - start < remaining && !this.stopRequested) {
      await new Promise((r) => setTimeout(r, Math.min(1000, remaining - (Date.now() - start))));
    }
  }

  // ── Cycle Callbacks ──────────────────────────────────────────────────────

  private onCycleStart(cycle: number, action: any): void {
    this.logger.debug(`Cycle ${cycle} started`);
    if (this.sseService) {
      void this.sseService.publish({
        type: 'orchestrator_cycle_start',
        cycle,
        action: action?.type,
        network: action?.network,
        reason: action?.reason,
      });
    }
  }

  private onCycleEnd(cycle: number, result: any, sleepMs: number): void {
    this.logger.debug(`Cycle ${cycle} ended: ${result?.type} (sleep ${sleepMs}ms)`);

    // Record action in history
    void this.recordHistory(cycle, result, sleepMs);

    if (this.sseService) {
      void this.sseService.publish({
        type: 'orchestrator_cycle_end',
        cycle,
        action: result?.type,
        success: result?.success,
        duration: result?.duration,
        sleepMs,
      });
    }
  }

  private async recordHistory(cycle: number, result: any, sleepMs: number): Promise<void> {
    try {
      const entry = JSON.stringify({
        cycle,
        type: result?.type,
        success: result?.success,
        duration: result?.duration,
        sleepMs,
        timestamp: Date.now(),
      });
      await this.redis.lpush(HISTORY_KEY, entry);
      await this.redis.ltrim(HISTORY_KEY, 0, HISTORY_MAX - 1);
    } catch {
      // non-critical
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
      const hb = await this.redis.get(HEARTBEAT_KEY);
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
      cycle: 0, // Updated from graph state in future
      heartbeat,
      heartbeatAgeMs,
    };
  }

  async getHistory(limit = 50): Promise<any[]> {
    try {
      const entries = await this.redis.lrange(HISTORY_KEY, 0, limit - 1);
      return entries.map((e) => JSON.parse(e));
    } catch {
      return [];
    }
  }
}
