/**
 * ActionExecutor — EXECUTE node implementation (WS-3).
 *
 * Routes Action to the appropriate handler via a strategy map.
 * Each action type has a dedicated IActionHandler implementation.
 * New actions = new handler class + registration, no dispatch modification.
 *
 * Feature-flagged services (Engagement, Replies) are resolved via Symbol DI
 * tokens (IBrowsingSessionPort, IRepliesMonitorPort) injected into the
 * respective handlers.
 *
 * Errors are caught and returned as ActionResult — never thrown.
 */

import { Injectable, Logger } from '@nestjs/common';
import type { Action, ActionResult } from './types.js';
import type { IActionHandler } from './action-handler.interface.js';
import {
  GenerateTopicsHandler,
  GeneratePostsHandler,
  PostHandler,
  BrowseHandler,
  RecoverSessionHandler,
  CheckRepliesHandler,
  RefreshTrendsHandler,
  HealthCheckHandler,
  ReconcileHandler,
  TriageQueueHandler,
  ScrapeMetricsHandler,
  RecycleContentHandler,
  AggregateHooksHandler,
} from './action-handlers.js';

@Injectable()
export class ActionExecutorService {
  private readonly logger = new Logger(ActionExecutorService.name);
  private readonly handlers: Map<string, IActionHandler>;

  constructor(
    private readonly generateTopicsHandler: GenerateTopicsHandler,
    private readonly generatePostsHandler: GeneratePostsHandler,
    private readonly postHandler: PostHandler,
    private readonly browseHandler: BrowseHandler,
    private readonly recoverSessionHandler: RecoverSessionHandler,
    private readonly checkRepliesHandler: CheckRepliesHandler,
    private readonly refreshTrendsHandler: RefreshTrendsHandler,
    private readonly healthCheckHandler: HealthCheckHandler,
    private readonly reconcileHandler: ReconcileHandler,
    private readonly triageQueueHandler: TriageQueueHandler,
    private readonly scrapeMetricsHandler: ScrapeMetricsHandler,
    private readonly recycleContentHandler: RecycleContentHandler,
    private readonly aggregateHooksHandler: AggregateHooksHandler,
  ) {
    this.handlers = new Map<string, IActionHandler>([
      [generateTopicsHandler.actionType, generateTopicsHandler],
      [generatePostsHandler.actionType, generatePostsHandler],
      [postHandler.actionType, postHandler],
      [browseHandler.actionType, browseHandler],
      [recoverSessionHandler.actionType, recoverSessionHandler],
      [checkRepliesHandler.actionType, checkRepliesHandler],
      [refreshTrendsHandler.actionType, refreshTrendsHandler],
      [healthCheckHandler.actionType, healthCheckHandler],
      [reconcileHandler.actionType, reconcileHandler],
      [triageQueueHandler.actionType, triageQueueHandler],
      [scrapeMetricsHandler.actionType, scrapeMetricsHandler],
      [recycleContentHandler.actionType, recycleContentHandler],
      [aggregateHooksHandler.actionType, aggregateHooksHandler],
    ]);
  }

  /**
   * Execute an action. Never throws — returns ActionResult with error info.
   */
  async execute(action: Action, options?: { signal?: AbortSignal }): Promise<ActionResult> {
    const startTime = Date.now();

    if (options?.signal?.aborted) {
      return { success: false, type: action.type, duration: 0, error: 'Action aborted' };
    }

    if (action.type === 'WAIT') {
      return { success: true, type: 'WAIT', duration: 0 };
    }

    try {
      const handler = this.handlers.get(action.type);
      if (!handler) {
        throw new Error(`Unknown action type: ${action.type}`);
      }

      const sideEffects = await handler.execute(action, options);

      if (options?.signal?.aborted) {
        throw new Error('Action aborted');
      }

      const duration = Date.now() - startTime;
      this.logger.log(`Executed ${action.type}${action.network ? `:${action.network}` : ''} in ${duration}ms`);
      return { success: true, type: action.type, duration, sideEffects };
    } catch (err) {
      const duration = Date.now() - startTime;
      const error = (err as Error).message;
      this.logger.error(`Execute ${action.type} failed in ${duration}ms: ${error}`);
      return { success: false, type: action.type, duration, error };
    }
  }
}
