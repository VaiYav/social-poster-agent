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
import type { CompiledStateGraph } from '@langchain/langgraph';
import type { StateCollectorService } from './state-collector.service.js';
import type { DecisionEngineService } from './decision-engine.service.js';
import type { ActionExecutorService } from './action-executor.service.js';
import type { OrchestratorService } from './orchestrator.service.js';
import type { WorldState, Action, ActionResult, ActionType } from './types.js';

// ── State Definition ───────────────────────────────────────────────────────

export const OrchestratorState = Annotation.Root({
  // OBSERVE: world state snapshot
  world: Annotation<WorldState>({
    reducer: (_, next) => next,
    default: () => null as unknown as WorldState,
  }),

  // DECIDE: chosen action
  action: Annotation<Action>({
    reducer: (_, next) => next,
    default: () => null as unknown as Action,
  }),

  // EXECUTE: result of last action
  result: Annotation<ActionResult>({
    reducer: (_, next) => next,
    default: () => null as unknown as ActionResult,
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
  orchestratorService: OrchestratorService;
  writeHeartbeat: () => Promise<void>;
  sleep: (ms: number) => Promise<void>;
  isStopped: () => boolean;
  onCycleStart?: (cycle: number, action: Action) => void;
  onCycleEnd?: (cycle: number, result: ActionResult, sleepMs: number) => void;
}

// ── Node Functions ──────────────────────────────────────────────────────────

/**
 * OBSERVE — collect world state from DB, Redis, services.
 */
function observeNode(deps: OrchestratorGraphDeps) {
  return async (state: OrchestratorStateType): Promise<Partial<OrchestratorStateType>> => {
    const world = await deps.stateCollector.collectWorldState();
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
    if (state.action.type === 'WAIT') {
      return { result: { success: true, type: 'WAIT', duration: 0 } };
    }

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
    const sleepMs = calculateAdaptiveSleep(state.action, state.world);

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

    return { sleepMs };
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

  // WAIT + idle → normal idle
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

  // Edges: linear cycle
  graph.addEdge(START, 'observe');
  graph.addEdge('observe', 'decide');
  graph.addEdge('decide', 'execute');
  graph.addEdge('execute', 'evaluate');

  // Conditional edge: evaluate → observe (loop) or END (if stopped)
  graph.addConditionalEdges('evaluate', (state: OrchestratorStateType) => {
    if (deps.isStopped()) {
      return END;
    }
    return 'observe';
  });

  return graph;
}

// ── Initial State ───────────────────────────────────────────────────────────

export function createInitialOrchestratorState(): OrchestratorStateType {
  return {
    world: null as unknown as WorldState,
    action: null as unknown as Action,
    result: null as unknown as ActionResult,
    cycle: 0,
    sleepMs: 60_000,
    heartbeat: Date.now(),
    errors: [],
  };
}
