/**
 * Feature flag utilities for the orchestrator migration.
 *
 * DEP-002 fix: the implementation now lives in domain/feature-flags.ts so that
 * infrastructure/ can import it without violating the hexagonal dependency
 * direction. This file re-exports for backward compatibility with existing
 * module-level imports.
 *
 * The orchestrator replaces all cron-based scheduling. When ORCHESTRATOR_ENABLED=true,
 * cron services skip cron registration entirely in their onModuleInit() — the cron
 * timer is never created, saving memory and CPU. Use `isOrchestratorEnabled()` to
 * check the flag at module-init time.
 */

export { isOrchestratorEnabled } from "../../domain/feature-flags.js";
