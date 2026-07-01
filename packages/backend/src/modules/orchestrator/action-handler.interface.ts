/**
 * Action handler strategy interface (X18).
 *
 * Each action type has a dedicated handler that implements this interface.
 * The ActionExecutorService dispatches to the appropriate handler via a Map.
 *
 * This follows the Strategy pattern — new actions can be added by creating
 * a new handler class and registering it, without modifying the executor.
 */

import type { Action } from './types.js';

export interface IActionHandler {
  /** The action type this handler processes */
  readonly actionType: string;

  /** Execute the action, returning side-effect metadata. Never throws. */
  execute(action: Action): Promise<Record<string, unknown>>;
}
