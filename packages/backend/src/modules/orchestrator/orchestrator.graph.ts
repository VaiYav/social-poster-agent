/**
 * OrchestratorGraph — LangGraph StateGraph for the orchestrator loop (WS-5).
 *
 * Graph structure:
 *   START → observe → decide → execute → evaluate → observe (loop)
 *
 * The graph cycles continuously, replacing all cron jobs. State is persisted
 * to Redis via RedisCheckpointSaver for crash-resume. Adaptive sleep between
 * cycles ensures efficiency (15s during recovery, 60s active, 300s idle, 600s night).
 *
 * V-Model: WS-5 (critical — the main loop that replaces all crons)
 */

import { StateGraph, END, START, Annotation } from '@langchain/langgraph';
import type { StateCollectorService } from './state-collector.service.js';
import type { DecisionEngineService } from './decision-engine.service.js';
import type { ActionExecutorService } from './action-executor.service.js';
import type { WorldState, Action, ActionResult } from './types.js';

// ── State Definition ───────────────────────────────────────────────────────

export const OrchestratorState = Annotation.Root({
  // OBSERVE: world state snapshot (null until first observe node runs)
  world: Annotation<WorldState | null>({
    reducer: (_, next) => next,
    default: () => null,
  }),

  // DECIDE: chosen action (null until first decide node runs)
  action: Annotation<Action | null>({
    reducer: (_, next) => next,
    default: () => null,
  }),

  // EXECUTE: result of last action (null until first execute node runs)
  result: Annotation<ActionResult | null>({
    reducer: (_, next) => next,
    default: () => null,
  }),

  // EVALUATE: loop control
  cycle: Annotation<number>({
    reducer: (prev, next) => prev + next,
    default: () => 0,
  }),
  sleepMs: Annotation<number>({
    reducer: (_, next) => next,
    default: () => 60000,
  }),
  heartbeat: Annotation<number>({
    reducer: (_, next) => next,
    default: () => Date.now(),
  }),

  // Error tracking (keep last 50)
  errors: Annotation<Error[]>({
    reducer: (prev, next) => [...prev, ...next].slice(-50),
    default: () => [],
  }),
});

export type OrchestratorStateType = typeof OrchestratorState.State;

// ── Dependencies (injected via factory) ─────────────────────────────────────

export interface OrchestratorGraphDeps {
  stateCollector: StateCollectorService;
  decisionEngine: DecisionEngineService;
  actionExecutor: ActionExecutorService;
  writeHeartbeat: () => Promise<void>;
  sleep: (ms: number) => Promise<void>;
  isStopped: () => boolean;
  onCycleEnd?: (cycle: number, result: ActionResult | null, sleepMs: number) => void;
  /** Fire-and-forget engagement check — enqueues stale browsing sessions in parallel */
  onEngagementCheck?: (world: WorldState) => void;
}

// ── Node Functions ──────────────────────────────────────────────────────────

/**
 * OBSERVE — collect world state from DB, Redis, services.
 * Also fires engagement check in parallel (fire-and-forget) so browsing sessions
 * are enqueued without blocking the main decision flow.
 */
function observeNode(deps: OrchestratorGraphDeps) {
  return async (_state: OrchestratorStateType): Promise<Partial<OrchestratorStateType>> => {
    const world = await deps.stateCollector.collectWorldState();

    // Fire-and-forget: check for stale browsing sessions and enqueue via BullMQ.
    // Runs in PARALLEL with the main decision — engagement never blocks content pipeline.
    if (deps.onEngagementCheck) {
      deps.onEngagementCheck(world);
    }

    return {
      world,
      heartbeat: Date.now(),
    };
  };
}

/**
 * DECIDE — choose next action (hard rules → LLM → guardrails).
 */
function decideNode(deps: OrchestratorGraphDeps) {
  return async (state: OrchestratorStateType): Promise<Partial<OrchestratorStateType>> => {
    if (!state.world) {
      // Observe failed catastrophically — return WAIT to retry next cycle
      return { action: { type: 'WAIT', reason: 'No world state (observe failed)', source: 'hard_rule' } };
    }
    const action = await deps.decisionEngine.decide(state.world);
    return { action };
  };
}

/**
 * EXECUTE — dispatch action to existing services.
 * WAIT actions skip execution entirely.
 */
function executeNode(deps: OrchestratorGraphDeps) {
  return async (state: OrchestratorStateType): Promise<Partial<OrchestratorStateType>> => {
    if (!state.action) {
      return { result: { success: false, type: 'WAIT', duration: 0, error: 'No action to execute' } };
    }
    if (state.action.type === 'WAIT') {
      return { result: { success: true, type: 'WAIT', duration: 0 } };
    }

    // Write heartbeat before executing — long-running actions (BROWSE, up to 15 min)
    // would otherwise let the heartbeat go stale and trigger a watchdog restart mid-action.
    await deps.writeHeartbeat();

    try {
      const result = await deps.actionExecutor.execute(state.action);
      return { result };
    } catch (err) {
      const error = err as Error;
      return {
        result: { success: false, type: state.action.type, duration: 0, error: error.message },
        errors: [error],
      };
    }
  };
}

/**
 * EVALUATE — calculate adaptive sleep, write heartbeat, actually sleep.
 */
function evaluateNode(deps: OrchestratorGraphDeps) {
  return async (state: OrchestratorStateType): Promise<Partial<OrchestratorStateType>> => {
    const action = state.action ?? { type: 'WAIT' as const, reason: 'No action', source: 'hard_rule' as const };
    const world = state.world;
    const sleepMs = world ? calculateAdaptiveSleep(action, world) : 60_000;

    // Write heartbeat before sleeping (so watchdog knows we're alive)
    await deps.writeHeartbeat();

    // Notify cycle end
    if (deps.onCycleEnd) {
      deps.onCycleEnd(state.cycle, state.result, sleepMs);
    }

    // Actually sleep (unless stopped)
    if (!deps.isStopped()) {
      await deps.sleep(sleepMs);
    }

    return { sleepMs, cycle: 1 };
  };
}

// ── Adaptive Sleep Logic ───────────────────────────────────────────────────

function calculateAdaptiveSleep(action: Action, world: WorldState): number {
  // Kill switch → short sleep to check if lifted
  if (world.flowControl.pauseAll) {
    return 60_000;
  }

  // Circuit breaker open → wait for reset
  const networks = Object.keys(world.sessions);
  for (const net of networks) {
    if (world.sessions[net]?.circuitBreaker === 'open') {
      return 60_000;
    }
  }

  // Rate limited → wait until reset (max 1 hour)
  for (const net of networks) {
    const rl = world.rateLimits[net];
    if (rl && rl.dailyRemaining === 0 && rl.lastPostMs > 0) {
      // Wait until midnight UTC (daily reset)
      const now = new Date();
      const nextReset = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1));
      const waitMs = nextReset.getTime() - now.getTime();
      return Math.min(waitMs, 3_600_000); // max 1 hour
    }
  }

  // RECOVER_SESSION → quick check if recovery worked
  if (action.type === 'RECOVER_SESSION') {
    return 15_000;
  }

  // Night mode (01:00-07:00 UTC) + no pending work
  const hour = world.utcHour;
  const isNight = hour >= 1 && hour < 7;
  const hasPendingWork =
    world.drafts.approved > 0 ||
    world.engagement.uncheckedReplies > 0 ||
    world.health.stuckPosting > 0 ||
    world.health.dlqDepth > 10;
  if (isNight && !hasPendingWork) {
    return 600_000; // 10 min
  }

  // Non-WAIT action → active mode
  if (action.type !== 'WAIT') {
    return 60_000;
  }

  // WAIT + idle → respect the requested sleep duration, default to 2 min
  const requestedMs = Number(action.params?.sleepMs);
  if (Number.isFinite(requestedMs) && requestedMs > 0) {
    return requestedMs;
  }
  return 120_000;
}

// ── Graph Builder ───────────────────────────────────────────────────────────

/**
 * Build the orchestrator StateGraph.
 * The graph loops: observe → decide → execute → evaluate → observe
 * It only terminates when the orchestrator is stopped (checked in evaluate node).
 */
export function buildOrchestratorGraph(deps: OrchestratorGraphDeps) {
  const graph = new StateGraph(OrchestratorState)
    .addNode('observe', observeNode(deps))
    .addNode('decide', decideNode(deps))
    .addNode('execute', executeNode(deps))
    .addNode('evaluate', evaluateNode(deps));

  // Edges: linear cycle — each invoke runs exactly ONE cycle (4 nodes).
  // The outer while loop in OrchestratorService handles repetition.
  // This avoids LangGraph recursion limit issues and gives better lifecycle control.
  graph.addEdge(START, 'observe');
  graph.addEdge('observe', 'decide');
  graph.addEdge('decide', 'execute');
  graph.addEdge('execute', 'evaluate');
  graph.addEdge('evaluate', END);

  return graph;
}

// ── Initial State ───────────────────────────────────────────────────────────

export function createInitialOrchestratorState(): OrchestratorStateType {
  return {
    world: null,
    action: null,
    result: null,
    cycle: 0,
    sleepMs: 60_000,
    heartbeat: Date.now(),
    errors: [],
  };
}
