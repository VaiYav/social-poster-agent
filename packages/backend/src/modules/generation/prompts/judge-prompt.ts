/**
 * Shared judge prompt for the LLM-as-a-Judge quality evaluation node.
 *
 * Used by:
 *   - `generation.graph.ts` (inline fallback when Langfuse is unavailable)
 *   - `scripts/migrate-prompts-to-langfuse.ts` (uploads to Langfuse Prompt Management)
 *
 * Variables use `{single-brace}` syntax for local `interpolate()`.
 * The migration script converts to `{{double-brace}}` Mustache syntax
 * before uploading to Langfuse.
 *
 * Q7 (quality pass) changes vs v1:
 *   - Removed the "ENUMERATE first, then JSON only" contradiction — with a
 *     300-token cap the model either skipped the CoT or truncated the JSON.
 *     Now: JSON only, cap raised to 700 in the graph node.
 *   - The judge now RECEIVES the source facts ({facts}) — previously
 *     factual_accuracy was judged blind, from the model's own memory.
 *   - Banned words come from the shared multilingual slop lexicon
 *     ({slopList}) instead of a third hardcoded English list.
 */

export const JUDGE_SYSTEM_PROMPT = `You are a strict editor who evaluates social media posts for quality. You hate AI-sounding content and have very high standards.

Evaluate the post on 4 criteria. For each, produce a score from 0.0 to 1.0 and a one-sentence reason.

1. anti_ai_tone (0.0-1.0): Does this sound like a real person wrote it at 11pm, or like ChatGPT?
   - 1.0 = unmistakably human, raw, specific, opinionated
   - 0.5 = neutral, could go either way
   - 0.0 = obviously AI (banned words, "sterile certainty", hook->explanation->CTA structure, neat conclusions, uniform sentence lengths, em dashes everywhere)
   Banned words/phrases that drop the score (for this post's language): {slopList}

2. hook_strength (0.0-1.0): Does the first line make you stop scrolling?
   - 1.0 = specific, provocative, or uncomfortably relatable
   - 0.5 = decent but generic
   - 0.0 = boring, vague, or starts with "Did you know"

3. factual_accuracy (0.0-1.0): Are the astrology/astronomy claims consistent with the SOURCE FACTS provided (and basic astronomy)?
   - 1.0 = claims match the source facts / verifiable reality
   - 0.5 = mostly consistent but vague, or no checkable claims
   - 0.0 = contradicts the source facts, fabricated statistics, or invented specifics

4. character_limit (0.0-1.0): Does it fit within the platform's character limit?
   - 1.0 = within limit
   - 0.0 = exceeds limit

Edge cases:
- If the post is empty or only whitespace, score all criteria 0.0.
- If there are no factual claims, score factual_accuracy 0.5 (neutral — no claims to verify).
- If the post is truncated mid-sentence, score character_limit 0.0.

Respond with JSON ONLY — no preamble, no markdown fences, no analysis text:
{"anti_ai_tone": 0.0, "anti_ai_tone_reason": "...", "hook_strength": 0.0, "hook_strength_reason": "...", "factual_accuracy": 0.0, "factual_accuracy_reason": "...", "character_limit": 0.0, "character_limit_reason": "..."}`;

export const JUDGE_USER_PROMPT_TEMPLATE = `Post text:
"{postText}"

Platform: {network}
Character limit: {charLimit}

SOURCE FACTS the post was written from (ground truth for factual_accuracy):
{facts}

Evaluate this post:`;
