/**
 * Orchestrator LLM prompt — soft decision optimization.
 *
 * The LLM receives a summarized WorldState and chooses the next action.
 * It is ONLY called when hard rules don't match (no safety-critical condition).
 * Output is validated by guardrails before execution.
 */

import type { WorldState } from '../types.js';

export const ORCHESTRATOR_SYSTEM_PROMPT = `You are a social media orchestrator agent. You decide what action to take next based on the current world state. You must choose exactly ONE action.

Available actions:
- GENERATE_TOPICS: Generate new content topics (when pool is low)
- GENERATE_POSTS: Generate post drafts from existing topics (when drafts are needed)
- POST: Enqueue an approved draft for posting (when in posting window)
- BROWSE: Start an engagement/browsing session (to look human)
- RECOVER_SESSION: Re-login to a social network (when session expired)
- CHECK_REPLIES: Check and reply to comments on posted content
- REFRESH_TRENDS: Scrape trending topics for content enrichment
- HEALTH_CHECK: Run a full system health scan
- RECONCILE: Re-enqueue stuck posts
- SCRAPE_METRICS: Collect engagement metrics from posted posts
- RECYCLE_CONTENT: Repurpose top-performing old posts
- AGGREGATE_HOOKS: Aggregate hook performance statistics
- WAIT: Do nothing this cycle

Rules:
- Never choose an action for a disabled network
- Never choose POST if dailyRemaining === 0
- Prefer GENERATE_TOPICS if topicPool.count < threshold
- Prefer GENERATE_POSTS if approved drafts === 0 and topicPool sufficient
- Prefer POST if approved drafts > 0 AND inPostingWindow === true
- Prefer BROWSE if lastBrowse > 4h ago AND session active
- Prefer CHECK_REPLIES if uncheckedReplies > 0
- Prefer REFRESH_TRENDS if trends.lastRefresh > 2h ago
- Prefer SCRAPE_METRICS if last scrape > 24h ago
- Prefer HEALTH_CHECK if last health check > 1h ago
- Prefer RECONCILE if stuckPosting > 0
- Prefer WAIT if none of the above apply
- Consider posting windows: post when audience is most active
- Consider recent performance: if last post underperformed, wait longer
- Only choose one action — the most important one right now

Respond with JSON only, no markdown:
{"action": "ACTION_TYPE", "network": "X|THREADS|FACEBOOK|null", "reason": "one sentence explanation"}`;

/**
 * Build the user prompt from WorldState.
 * Summarizes state into a concise format for the LLM.
 */
export function buildOrchestratorUserPrompt(world: WorldState): string {
  const hour = world.utcHour;
  const minute = new Date(world.now).getUTCMinutes();
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const dayName = days[world.utcDayOfWeek] ?? '?';

  const topicAgeHours = world.topicPool.oldestAgeMs
    ? Math.round(world.topicPool.oldestAgeMs / (60 * 60 * 1000))
    : 0;

  const lines: string[] = [
    `Current state (UTC ${hour}:${String(minute).padStart(2, '0')}, ${dayName}):`,
    `- Topic pool: ${world.topicPool.count}/${world.topicPool.threshold} (oldest: ${topicAgeHours}h)`,
    `- Approved drafts: ${world.drafts.approved}`,
    `- Queue depth: X=${world.queueDepth['X'] ?? 0}, THREADS=${world.queueDepth['THREADS'] ?? 0}`,
  ];

  // Sessions
  const sessionParts: string[] = [];
  for (const [net, s] of Object.entries(world.sessions)) {
    sessionParts.push(`${net}=${s.status}(${s.circuitBreaker})`);
  }
  lines.push(`- Sessions: ${sessionParts.join(', ')}`);

  // Rate limits
  const rateParts: string[] = [];
  for (const [net, r] of Object.entries(world.rateLimits)) {
    rateParts.push(`${net} daily=${r.dailyRemaining}/weekly=${r.weeklyRemaining}`);
  }
  lines.push(`- Rate limits: ${rateParts.join(', ')}`);

  // Last post time
  const lastPostParts: string[] = [];
  for (const [net, r] of Object.entries(world.rateLimits)) {
    if (r.lastPostMs > 0) {
      const hoursAgo = Math.round((Date.now() - r.lastPostMs) / (60 * 60 * 1000));
      lastPostParts.push(`${net}=${hoursAgo}h ago`);
    } else {
      lastPostParts.push(`${net}=never`);
    }
  }
  lines.push(`- Last post: ${lastPostParts.join(', ')}`);

  // Posting windows
  const windowParts: string[] = [];
  for (const [net, w] of Object.entries(world.postingWindows)) {
    if (w) {
      windowParts.push(`${net}=${w.inWindow ? 'IN' : 'OUT'}(${w.bestHours.join(',')})`);
    }
  }
  lines.push(`- Posting window: ${windowParts.join(', ') || 'none'}`);

  // Engagement
  const browseParts: string[] = [];
  for (const [net, ms] of Object.entries(world.engagement.lastBrowseMs)) {
    if (ms > 0) {
      const hoursAgo = Math.round((Date.now() - ms) / (60 * 60 * 1000));
      browseParts.push(`${net}=${hoursAgo}h ago`);
    } else {
      browseParts.push(`${net}=never`);
    }
  }
  lines.push(`- Last browse: ${browseParts.join(', ')}`);
  lines.push(`- Unchecked replies: ${world.engagement.uncheckedReplies}`);

  // Trends
  const trendAgeHours = world.trends.lastRefreshMs
    ? Math.round((Date.now() - world.trends.lastRefreshMs) / (60 * 60 * 1000))
    : 0;
  lines.push(`- Trends: ${world.trends.count} (last refresh: ${trendAgeHours}h ago)`);

  // Health
  lines.push(`- Health: bans=${world.health.bans}, DLQ=${world.health.dlqDepth}, stuck=${world.health.stuckPosting}`);

  // Performance
  const perfParts: string[] = [];
  for (const [net, p] of Object.entries(world.performance)) {
    perfParts.push(`${net} avg=${Math.round(p.recentAvgEngagement)}`);
  }
  lines.push(`- Recent engagement: ${perfParts.join(', ') || 'no data'}`);

  // Flow control
  if (world.flowControl.pauseAll) {
    lines.push('- ⚠️ KILL SWITCH ACTIVE');
  }

  lines.push('');
  lines.push('Respond with JSON: {"action": "ACTION_TYPE", "network": "X|THREADS|FACEBOOK|null", "reason": "one sentence"}');

  return lines.join('\n');
}
