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

import {
  Injectable,
  Logger,
  OnModuleInit,
  OnModuleDestroy,
  Inject,
  Optional,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { EventEmitter2 } from "@nestjs/event-emitter";
import { SHARED_REDIS } from "../../infrastructure/redis/redis.module.js";
import type IORedis from "ioredis";
import { RedisCheckpointSaver } from "../../infrastructure/checkpoint/redis-checkpoint.js";
import { parseBool } from "../../infrastructure/config/parse-bool.js";
import { StateCollectorService } from "./state-collector.service.js";
import { DecisionEngineService } from "./decision-engine.service.js";
import { ActionExecutorService } from "./action-executor.service.js";
import { OrchestratorHistoryService } from "./orchestrator-history.service.js";
import { buildOrchestratorGraph, createInitialOrchestratorState } from "./orchestrator.graph.js";
import type { OrchestratorStateType } from "./orchestrator.graph.js";
import type { CompiledStateGraph } from "@langchain/langgraph";
import type { ActionResult, WorldState } from "./types.js";
import type { OrchestratorCycleEndEvent } from "@spa/shared";
import { OrchestratorEvents } from "../../events/enums/post-events.enum.js";
import { EngagementSchedulerService } from "../engagement/engagement-scheduler.service.js";
import {
  DISTRIBUTED_LOCK_SERVICE,
  DistributedLockService,
  type DistributedLock,
} from "../../infrastructure/multi-instance/distributed-lock.service.js";

// LangGraph's CompiledStateGraph generics are complex (state type + config type).
// We type the state parameter properly and use the SDK's Record-based config default.
type AnyCompiledGraph = CompiledStateGraph<OrchestratorStateType, Record<string, unknown>>;

const THREAD_ID = "orchestrator";
const HEARTBEAT_KEY_DEFAULT = "spa:orchestrator:heartbeat";
const HEARTBEAT_TTL_MS_DEFAULT = 1_800_000;
const LEADER_KEY_DEFAULT = "spa:orchestrator:leader";
const LEADER_TTL_MS_DEFAULT = 30_000;
const LEADER_RENEW_MS_DEFAULT = 10_000;
const CHECKPOINT_KEY_PREFIX = "spa:checkpoint"; // must match RedisCheckpointSaver.prefix

@Injectable()
export class OrchestratorService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(OrchestratorService.name);
  private readonly enabled: boolean;
  private readonly heartbeatKey: string;
  private readonly heartbeatTtlMs: number;

  private running = false;
  private stopRequested = false;
  private graphPromise: Promise<void> | null = null;
  private graphAbort: AbortController | null = null;
  private sleepAbort: AbortController | null = null;
  private currentCycle = 0;
  private graphRunId = 0;

  // Mutex to prevent concurrent start/stop/restart (watchdog + API race)
  private lifecycleLock = false;

  // Multi-instance leader election
  private readonly leaderKey: string;
  private readonly leaderTtlMs: number;
  private readonly leaderRenewMs: number;
  private leaderLock: DistributedLock | null = null;
  private leaderRenewTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly configService: ConfigService,
    @Inject(SHARED_REDIS) private readonly redis: IORedis,
    private readonly stateCollector: StateCollectorService,
    private readonly decisionEngine: DecisionEngineService,
    private readonly actionExecutor: ActionExecutorService,
    private readonly historyService: OrchestratorHistoryService,
    @Inject(DISTRIBUTED_LOCK_SERVICE) private readonly lockService: DistributedLockService,
    @Optional() private readonly checkpointSaver: RedisCheckpointSaver,
    @Optional() private readonly eventEmitter: EventEmitter2,
    @Optional() private readonly engagementScheduler?: EngagementSchedulerService,
  ) {
    this.enabled = parseBool(this.configService.get<string>("ORCHESTRATOR_ENABLED") ?? "false");
    this.heartbeatKey =
      this.configService.get<string>("ORCHESTRATOR_HEARTBEAT_KEY") ?? HEARTBEAT_KEY_DEFAULT;
    this.heartbeatTtlMs = Number(
      this.configService.get<string>("ORCHESTRATOR_HEARTBEAT_TTL_MS") ?? HEARTBEAT_TTL_MS_DEFAULT,
    );
    this.leaderKey =
      this.configService.get<string>("ORCHESTRATOR_LEADER_KEY") ?? LEADER_KEY_DEFAULT;
    this.leaderTtlMs = Number(
      this.configService.get<string>("ORCHESTRATOR_LEADER_TTL_MS") ?? LEADER_TTL_MS_DEFAULT,
    );
    this.leaderRenewMs = Number(
      this.configService.get<string>("ORCHESTRATOR_LEADER_RENEW_INTERVAL_MS") ??
        LEADER_RENEW_MS_DEFAULT,
    );
  }

  async onModuleInit(): Promise<void> {
    if (this.enabled) {
      try {
        await this.start();
      } catch (err) {
        this.logger.error(`Orchestrator failed to start: ${(err as Error).message}`);
        throw err;
      }
    }
  }

  async onModuleDestroy(): Promise<void> {
    await this.stop();
  }

  async start(): Promise<void> {
    if (this.lifecycleLock) {
      this.logger.warn("Lifecycle operation in progress — start skipped");
      return;
    }
    if (this.running || this.graphPromise) {
      this.logger.warn("Orchestrator already running");
      return;
    }

    this.lifecycleLock = true;
    try {
      this.stopRequested = false;
      this.currentCycle = 0;
      this.logger.log("Orchestrator starting...");

      // Multi-instance: only one instance may run the orchestrator graph.
      const leaderLock = await this.lockService.tryAcquire(this.leaderKey, this.leaderTtlMs);
      if (!leaderLock) {
        this.logger.warn(`Orchestrator leader lock held by another instance (${this.leaderKey})`);
        return;
      }
      this.leaderLock = leaderLock;
      this.startLeaderRenewal();
      this.logger.log("Orchestrator leader lock acquired");

      try {
        // Build graph dependencies
        // Each run gets its own AbortController so a stop/restart aborts the
        // current graph without affecting a new one.
        const graphAbort = new AbortController();
        this.graphAbort = graphAbort;
        const runId = ++this.graphRunId;

        const deps = {
          stateCollector: this.stateCollector,
          decisionEngine: this.decisionEngine,
          actionExecutor: this.actionExecutor,
          writeHeartbeat: () => this.writeHeartbeat(),
          sleep: (ms: number) => this.sleep(ms),
          isStopped: () => this.stopRequested || graphAbort.signal.aborted,
          onCycleEnd: (cycle: number, result: ActionResult | null, sleepMs: number) =>
            this.onCycleEnd(cycle, result, sleepMs),
          onEngagementCheck: (world: WorldState) => this.onEngagementCheck(world),
          timeoutConfig: {
            f1BrowsingSessionMinutes: Number(
              this.configService.get<string>("F1_BROWSING_SESSION_MINUTES", "15"),
            ),
            orchestratorGenerateTimeoutMs: Number(
              this.configService.get<string>("ORCHESTRATOR_GENERATE_TIMEOUT_MS", "1200000"),
            ),
          },
        };

        // Build and compile graph
        const graphBuilder = buildOrchestratorGraph(deps);
        const compileOpts: { checkpointer?: RedisCheckpointSaver } = {};
        if (this.checkpointSaver) {
          compileOpts.checkpointer = this.checkpointSaver;
        }
        const compiledGraph = graphBuilder.compile(compileOpts) as AnyCompiledGraph;

        // Run graph in background; set promise BEFORE running=true so stop() cannot
        // observe a running graph without a promise to wait on.
        const promise = this.runGraphLoop(compiledGraph, graphAbort);
        this.graphPromise = promise;
        this.running = true;

        // 2.6.3: clean up the promise when the loop actually exits so a subsequent
        // start() cannot start a second loop while the old one is still stopping.
        // Use runId to avoid clobbering a new start() that happened while the
        // previous loop was still winding down.
        promise.catch(() => {});
        promise
          .finally(() => {
            if (this.graphRunId === runId) {
              this.graphPromise = null;
              this.running = false;
            }
          })
          .catch(() => {});

        this.logger.log("Orchestrator started");
      } catch (err) {
        this.stopLeaderRenewal();
        await this.releaseLeaderLock();
        throw err;
      }
    } finally {
      this.lifecycleLock = false;
    }
  }

  async stop(): Promise<void> {
    if (this.lifecycleLock) {
      this.logger.warn("Lifecycle operation in progress — stop skipped");
      return;
    }
    if (!this.running && !this.graphPromise && !this.leaderLock) return;

    this.lifecycleLock = true;
    try {
      this.stopRequested = true;
      this.logger.log("Orchestrator stop requested...");

      // Stop leader lock renewal before aborting the sleep, so the lock
      // is not extended while we are trying to release it.
      this.stopLeaderRenewal();

      // Abort the current graph invocation and any in-progress sleep so the
      // loop can check stopRequested / graphAbort.signal.
      this.graphAbort?.abort();
      this.sleepAbort?.abort();

      // 2.6.3: wait for the graph loop to actually exit before declaring stopped.
      // The start() promise cleanup handles the normal exit path; this awaits it
      // explicitly so stop() cannot return while runGraphLoop is still running.
      // Use a hard timeout so a non-cooperative graph cannot block restart forever.
      const STOP_TIMEOUT_MS = 15_000;
      const stopRunId = this.graphRunId;
      const graphPromise = this.graphPromise;
      if (graphPromise) {
        let stopTimer: ReturnType<typeof setTimeout> | undefined;
        const stopTimeout = new Promise<void>((resolve) => {
          stopTimer = setTimeout(resolve, STOP_TIMEOUT_MS);
        });
        await Promise.race([graphPromise.catch(() => void 0), stopTimeout]);
        clearTimeout(stopTimer);
      }

      // Release the leader lock so another instance can take over immediately.
      await this.releaseLeaderLock();

      if (this.graphRunId === stopRunId) {
        this.running = false;
        this.graphPromise = null;
        this.graphAbort = null;
      }
      this.logger.log("Orchestrator stopped");
    } finally {
      this.lifecycleLock = false;
    }
  }

  isRunning(): boolean {
    return this.running;
  }

  /**
   * Reset checkpoint — allows a fresh start without resuming old state.
   * Deletes the orchestrator thread's checkpoint keys (pointer + per-checkpoint + writes).
   * Routes through RedisCheckpointSaver so a dedicated checkpoint Redis is respected.
   */
  async resetCheckpoint(): Promise<void> {
    try {
      await this.checkpointSaver?.deleteRunCheckpoints(THREAD_ID);
    } catch (err) {
      this.logger.warn(`Checkpoint reset failed: ${(err as Error).message}`);
    }
  }

  // ── Graph Loop ───────────────────────────────────────────────────────────

  private async runGraphLoop(
    compiledGraph: AnyCompiledGraph,
    graphAbort: AbortController,
  ): Promise<void> {
    // Check if we have a checkpoint to resume from
    let hasCheckpoint = false;
    try {
      const checkpoint = await this.checkpointSaver?.getTuple({
        configurable: { thread_id: THREAD_ID },
      });
      if (checkpoint) {
        // Sanity check — if cycle counter is absurdly high (doubling bug from
        // passing full state as input), reset the checkpoint and start fresh
        const checkpointState = checkpoint.checkpoint?.channel_values;
        const cycleValue = checkpointState?.cycle as number | undefined;
        if (typeof cycleValue === "number" && cycleValue > 1_000_000) {
          this.logger.warn(
            `Checkpoint cycle=${cycleValue} is abnormally high (doubling bug) — resetting checkpoint`,
          );
          await this.resetCheckpoint();
          hasCheckpoint = false;
        } else {
          hasCheckpoint = true;
          this.logger.log(`Resuming orchestrator from checkpoint (cycle=${cycleValue ?? 0})`);
        }
      }
    } catch {
      this.logger.warn("Failed to load checkpoint, starting fresh");
    }

    while (!this.stopRequested && !graphAbort.signal.aborted) {
      try {
        // On first iteration without checkpoint: pass full initial state.
        // On subsequent iterations: pass ONLY reset fields (world/action/result = null).
        // Do NOT pass cycle/sleepMs/heartbeat — those come from the checkpoint.
        // Passing the full previous state would cause the cycle reducer
        // (prev + next) to DOUBLE the cycle counter each iteration.
        const input = hasCheckpoint
          ? ({ world: null, action: null, result: null } as Partial<OrchestratorStateType>)
          : createInitialOrchestratorState();

        const result = await compiledGraph.invoke(input, {
          configurable: { thread_id: THREAD_ID },
          signal: graphAbort.signal,
        });

        hasCheckpoint = true; // checkpoint now exists after first invoke
        const resultState = result as OrchestratorStateType;
        this.currentCycle = resultState.cycle;
      } catch (err) {
        this.logger.error(`Orchestrator cycle error: ${(err as Error).message}`);
        if (this.stopRequested || graphAbort.signal.aborted) {
          this.logger.log("Orchestrator stopping after cycle error");
          return;
        }
        await this.sleep(60_000);
      }
    }

    this.logger.log("Orchestrator loop exited");
  }

  // ── Heartbeat ────────────────────────────────────────────────────────────

  private async writeHeartbeat(): Promise<void> {
    try {
      await this.redis.set(this.heartbeatKey, String(Date.now()), "PX", this.heartbeatTtlMs);
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
        signal.removeEventListener("abort", onAbort);
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
        signal.addEventListener("abort", onAbort, { once: true });
      }
    });

    this.sleepAbort = null;
  }

  // ── Engagement Check (parallel, fire-and-forget) ──────────────────────────

  /**
   * Called from observeNode on every cycle — checks for stale browsing sessions
   * and enqueues them via BullMQ. Runs in PARALLEL with the main decision flow
   * so engagement (likes, scrolling) never blocks content pipeline (generation, posting).
   *
   * Fire-and-forget: errors are logged but never propagate to the graph loop.
   */
  private onEngagementCheck(world: WorldState): void {
    if (!this.engagementScheduler) {
      this.logger.warn("Engagement check skipped: EngagementSchedulerService not injected");
      return;
    }
    this.logger.debug("Engagement check running");
    void this.engagementScheduler.checkStaleAndEnqueue(world).catch((err) => {
      this.logger.warn(`Engagement check failed: ${(err as Error).message}`);
    });
  }

  // ── Cycle Callbacks ──────────────────────────────────────────────────────

  private onCycleEnd(cycle: number, result: ActionResult | null, sleepMs: number): void {
    this.logger.debug(`Cycle ${cycle} ended: ${result?.type ?? "N/A"} (sleep ${sleepMs}ms)`);

    // Update currentCycle so getStatus() reflects the latest completed cycle
    // while the graph is sleeping between cycles.
    this.currentCycle = cycle;

    void this.historyService.record(cycle, result, sleepMs);

    // Emit domain event — SseEventListener bridges to SSE
    if (this.eventEmitter) {
      this.eventEmitter.emit(OrchestratorEvents.CYCLE_END, {
        cycle,
        action: result?.type,
        success: result?.success,
        duration: result?.duration,
        sleepMs,
      } satisfies OrchestratorCycleEndEvent);
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

  /**
   * Expose the full WorldState snapshot for the real-time dashboard.
   * Safe to call while the orchestrator is running.
   */
  async getWorldState(): Promise<WorldState> {
    return this.stateCollector.collectWorldState();
  }

  // ── Leader lock renewal ──────────────────────────────────────────────────

  private startLeaderRenewal(): void {
    if (this.leaderRenewTimer) return;
    this.scheduleLeaderRenewal();
  }

  private stopLeaderRenewal(): void {
    if (this.leaderRenewTimer) {
      clearTimeout(this.leaderRenewTimer);
      this.leaderRenewTimer = null;
    }
  }

  private scheduleLeaderRenewal(): void {
    this.leaderRenewTimer = setTimeout(async () => {
      this.leaderRenewTimer = null;
      await this.renewLeaderLock();
      if (this.leaderLock) {
        this.scheduleLeaderRenewal();
      }
    }, this.leaderRenewMs);
  }

  private async renewLeaderLock(): Promise<void> {
    const lock = this.leaderLock;
    if (!lock) return;
    try {
      const ok = await lock.extend(this.leaderTtlMs);
      if (!ok) {
        this.logger.warn("Lost orchestrator leader lock — stopping");
        this.stopRequested = true;
        this.sleepAbort?.abort();
      }
    } catch (err) {
      this.logger.warn(`Leader lock renewal failed: ${(err as Error).message} — stopping`);
      this.stopRequested = true;
      this.sleepAbort?.abort();
    }
  }

  private async releaseLeaderLock(): Promise<void> {
    if (!this.leaderLock) return;
    try {
      await this.leaderLock.release();
      this.logger.log("Orchestrator leader lock released");
    } catch (err) {
      this.logger.warn(`Failed to release orchestrator leader lock: ${(err as Error).message}`);
    } finally {
      this.leaderLock = null;
    }
  }
}
