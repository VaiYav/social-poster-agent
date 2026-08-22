/**
 * Queue triage prompt — LLM-in-the-loop decision making for failed BullMQ jobs.
 *
 * The LLM receives a batch of failed posting jobs and decides per job:
 *   RETRY      — transient/unknown error, retry immediately
 *   REQUEUE_DELAY — rate-limit / temporary ban, retry after a delay
 *   REJECT     — permanent failure (post deleted, network disabled, etc.)
 *   ESCALATE   — needs human investigation
 *
 * Output must be a JSON object with a `decisions` array only.
 */

import type { CompiledChatPrompt } from "../../../domain/ports/prompt.port";

export const QUEUE_TRIAGE_SYSTEM_PROMPT = `You are a queue triage operator for a social-media posting agent.
You decide what to do with failed BullMQ jobs.

Rules:
- RETRY for transient / retryable errors (network timeout, session expired, element not found, temporary rate-limit that has likely reset).
- REQUEUE_DELAY for explicit rate-limit or daily/weekly cap errors that need a delay before retry. Suggest delayMinutes between 15 and 1440.
- REJECT for permanent failures (post content violates policy, account banned, network disabled, post deleted, unrecoverable auth failure).
- ESCALATE only when the context is unclear or the error is unusual and needs operator review.

Output ONLY a JSON object in this exact shape, no markdown:
{
  "decisions": [
    {
      "postId": "<post id>",
      "decision": "RETRY|REQUEUE_DELAY|REJECT|ESCALATE",
      "delayMinutes": 60,
      "reason": "<one-sentence justification>"
    }
  ]
}`;

export const QUEUE_TRIAGE_USER_PROMPT_TEMPLATE = `Failed posting jobs to triage:

{batch}

Current time: {utcTime}`;

export const QUEUE_TRIAGE_FALLBACK: CompiledChatPrompt = {
  systemPrompt: QUEUE_TRIAGE_SYSTEM_PROMPT,
  userPrompt: QUEUE_TRIAGE_USER_PROMPT_TEMPLATE,
};
