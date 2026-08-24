/**
 * One-time migration script: uploads all production prompts to Langfuse
 * Prompt Management. Run with: npx tsx --env-file=../../.env scripts/migrate-prompts-to-langfuse.ts
 *
 * After migration, prompts can be edited in the Langfuse UI without redeploying.
 * The PromptRegistry fetches from Langfuse at runtime with local fallback.
 *
 * Variables use Langfuse {{double-brace}} syntax. Conditional logic that was
 * inline in the graph nodes (e.g. performanceGuidance, baitInstruction) is
 * pre-computed in code and passed as variables.
 */
import { LangfuseClient, type ChatMessage } from "@langfuse/client";
import { toMustache } from "../src/domain/prompt-interpolation.js";
import {
  RESEARCH_EXTRACT_PROMPT,
  HOOK_GENERATION_PROMPT,
  DRAFT_POST_PROMPT,
  CRITIQUE_POST_PROMPT,
  REFINE_POST_PROMPT,
} from "../src/modules/generation/prompts/fallback-prompts.js";
import {
  JUDGE_SYSTEM_PROMPT,
  JUDGE_USER_PROMPT_TEMPLATE,
} from "../src/modules/generation/prompts/judge-prompt.js";
import { ORCHESTRATOR_SYSTEM_PROMPT } from "../src/modules/orchestrator/prompts/orchestrator-prompt.js";
import { TOPIC_GENERATION_PROMPT } from "../src/infrastructure/content/prompts/topic-generation-prompt.js";
import { TRENDING_RELEVANCE_PROMPT } from "../src/modules/trending/prompts/trending-relevance-prompt.js";
import {
  ENGAGEMENT_DECISION_PROMPT,
  ENGAGEMENT_BATCH_DECISION_PROMPT,
  ENGAGEMENT_COMMENT_PROMPT,
  ENGAGEMENT_QUOTE_PROMPT,
  COMMENT_JUDGE_PROMPT,
} from "../src/infrastructure/llm/prompts/v0.4.0/engagement-decision.js";
import { QUESTION_CLASSIFIER_PROMPT } from "../src/modules/replies/prompts/question-classifier.prompt.js";
import { COMMENT_SAFETY_PROMPT } from "../src/modules/replies/prompts/comment-safety.prompt.js";
import { REPLY_DECISION_PROMPT } from "../src/modules/replies/prompts/reply-decision.prompt.js";

// Env vars loaded via: npx tsx --env-file=../../.env scripts/migrate-prompts-to-langfuse.ts

const publicKey = process.env.LANGFUSE_PUBLIC_KEY;
const secretKey = process.env.LANGFUSE_SECRET_KEY;

if (!publicKey || !secretKey) {
  console.error("❌ Missing required env vars: LANGFUSE_PUBLIC_KEY and LANGFUSE_SECRET_KEY");
  console.error("Run with: npx tsx --env-file=../../.env scripts/migrate-prompts-to-langfuse.ts");
  process.exit(1);
}

const client = new LangfuseClient({
  publicKey,
  secretKey,
  baseUrl: process.env.LANGFUSE_BASE_URL || "https://us.cloud.langfuse.com",
});

/**
 * Build the set of labels for a prompt from:
 * 1. the base labels defined below (always includes 'production')
 * 2. PROMPT_VERSION_<NAME> env var override
 * 3. PROMPT_VERSION global env var
 * 'latest' is a reserved built-in label and is skipped.
 */
function getLabels(baseLabels: string[], name: string): string[] {
  const labels = new Set(baseLabels);
  const normalizedName = name.replace(/[^a-zA-Z0-9]+/g, "_").toUpperCase();
  const perPromptLabel = process.env[`PROMPT_VERSION_${normalizedName}`];
  if (perPromptLabel && perPromptLabel !== "latest") labels.add(perPromptLabel);
  const globalLabel = process.env.PROMPT_VERSION;
  if (globalLabel && globalLabel !== "latest") labels.add(globalLabel);
  return [...labels];
}

function chatMessages(prompt: { systemPrompt: string; userPrompt: string }): ChatMessage[] {
  return [
    { role: "system", content: toMustache(prompt.systemPrompt) },
    { role: "user", content: toMustache(prompt.userPrompt) },
  ];
}

// ─── Prompt definitions ──────────────────────────────────────────────────────

type PromptDef =
  | { name: string; type: "chat"; labels: string[]; prompt: ChatMessage[] }
  | { name: string; type: "text"; labels: string[]; prompt: string };

const PROMPTS: PromptDef[] = [
  {
    name: "research-extract",
    type: "chat" as const,
    labels: ["production"],
    prompt: chatMessages(RESEARCH_EXTRACT_PROMPT),
  },
  {
    name: "hook-generation",
    type: "chat" as const,
    labels: ["production"],
    prompt: chatMessages(HOOK_GENERATION_PROMPT),
  },
  {
    name: "draft-post",
    type: "chat" as const,
    labels: ["production"],
    prompt: chatMessages(DRAFT_POST_PROMPT),
  },
  {
    name: "critique-post",
    type: "text" as const,
    labels: ["production"],
    prompt: toMustache(CRITIQUE_POST_PROMPT),
  },
  {
    name: "refine-post",
    type: "text" as const,
    labels: ["production"],
    prompt: toMustache(REFINE_POST_PROMPT),
  },
  {
    name: "orchestrator-system",
    type: "text" as const,
    labels: ["production"],
    prompt: toMustache(ORCHESTRATOR_SYSTEM_PROMPT),
  },
  {
    name: "post-quality-judge",
    type: "chat" as const,
    labels: ["production"],
    prompt: [
      { role: "system", content: JUDGE_SYSTEM_PROMPT },
      { role: "user", content: toMustache(JUDGE_USER_PROMPT_TEMPLATE) },
    ],
  },
  {
    name: "topic-generation",
    type: "chat" as const,
    labels: ["production"],
    prompt: chatMessages(TOPIC_GENERATION_PROMPT),
  },
  {
    name: "trending-relevance",
    type: "chat" as const,
    labels: ["production"],
    prompt: chatMessages(TRENDING_RELEVANCE_PROMPT),
  },
  {
    name: "engagement-decision",
    type: "chat" as const,
    labels: ["production"],
    prompt: chatMessages(ENGAGEMENT_DECISION_PROMPT),
  },
  {
    name: "engagement-batch-decision",
    type: "chat" as const,
    labels: ["production"],
    prompt: chatMessages(ENGAGEMENT_BATCH_DECISION_PROMPT),
  },
  {
    name: "engagement-comment",
    type: "chat" as const,
    labels: ["production"],
    prompt: chatMessages(ENGAGEMENT_COMMENT_PROMPT),
  },
  {
    name: "engagement-quote",
    type: "chat" as const,
    labels: ["production"],
    prompt: chatMessages(ENGAGEMENT_QUOTE_PROMPT),
  },
  {
    name: "comment-judge",
    type: "chat" as const,
    labels: ["production"],
    prompt: chatMessages(COMMENT_JUDGE_PROMPT),
  },
  {
    name: "question-classifier",
    type: "chat" as const,
    labels: ["production"],
    prompt: chatMessages({
      systemPrompt: QUESTION_CLASSIFIER_PROMPT,
      userPrompt: 'Comment: "{{commentText}}"\n\nReturn JSON only.',
    }),
  },
  {
    name: "comment-safety",
    type: "chat" as const,
    labels: ["production"],
    prompt: chatMessages({
      systemPrompt: COMMENT_SAFETY_PROMPT,
      userPrompt: 'Comment: "{{commentText}}"\n\nReturn JSON only.',
    }),
  },
  {
    name: "reply-decision",
    type: "chat" as const,
    labels: ["production"],
    prompt: chatMessages({
      systemPrompt: REPLY_DECISION_PROMPT,
      userPrompt: `Post: "{{postContent}}"

Latest comment from @{{author}}: "{{commentText}}"

Return JSON only.`,
    }),
  },
];

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`\n🚀 Migrating ${PROMPTS.length} prompts to Langfuse...\n`);

  for (const p of PROMPTS) {
    const labels = getLabels(p.labels, p.name);
    try {
      if (p.type === "chat") {
        const created = await client.prompt.create({
          name: p.name,
          type: "chat",
          prompt: p.prompt,
          labels,
        });
        console.log(`  ✅ ${p.name} (chat, v${created.version}, labels: ${labels.join(", ")})`);
      } else {
        const created = await client.prompt.create({
          name: p.name,
          type: "text",
          prompt: p.prompt,
          labels,
        });
        console.log(`  ✅ ${p.name} (text, v${created.version}, labels: ${labels.join(", ")})`);
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`  ❌ ${p.name}: ${message}`);
    }
  }

  console.log("\n✅ Migration complete. Prompts are now editable in the Langfuse UI.\n");
  console.log("Next steps:");
  console.log("  1. Verify prompts in Langfuse UI → Prompts");
  console.log("  2. Run the app — PromptRegistry will fetch from Langfuse");
  console.log("  3. Edit prompts in the UI without redeploying\n");

  process.exit(0);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
