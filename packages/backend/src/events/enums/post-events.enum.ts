/**
 * Sprint O: EDA Domain Events — internal event bus for decoupling.
 *
 * Posts module emits events instead of directly calling Queue/SSE modules.
 * Listeners handle side effects (enqueue, SSE publish, metrics, etc.)
 */
export enum PostEvents {
  DRAFT_GENERATED = 'post.draft_generated',
  APPROVED = 'post.approved',
  POSTING_STARTED = 'post.posting_started',
  POSTED = 'post.posted',
  VERIFIED = 'post.post_verified',
  FAILED = 'post.failed',
  REJECTED = 'post.rejected',
}

export enum SessionEvents {
  LOGIN_SUCCESS = 'session.login_success',
  LOGIN_FAILED = 'session.login_failed',
  SESSION_EXPIRED = 'session.session_expired',
  SESSION_BANNED = 'session.session_banned',
  BAN_RECOVERED = 'session.ban_recovered',
}

export enum GenerationEvents {
  RUN_STARTED = 'generation.run_started',
  RUN_COMPLETED = 'generation.run_completed',
  RUN_FAILED = 'generation.run_failed',
  RUN_PAUSED = 'generation.run_paused',
  RUN_RESUMED = 'generation.run_resumed',
}

export enum OrchestratorEvents {
  CYCLE_END = 'orchestrator.cycle_end',
}
