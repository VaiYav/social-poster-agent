import { StateGraph, END, START, Annotation } from "@langchain/langgraph";
import { Logger } from "@nestjs/common";
import type { ILlmPort } from "../../domain/ports/llm.port.js";
import type { IPromptPort } from "../../domain/ports/prompt.port.js";
import type {
  ArticleGraphState,
  ArticleContent,
  ArticleOutlineSection,
  ArticleJudgeScores,
  GenerateArticleOptions,
} from "@spa/shared";
import { SocialNetwork } from "../../generated/prisma/client.js";
import type { CanonicalUrlService } from "../canonical/canonical-url.service.js";
import {
  ARTICLE_RESEARCH_EXTRACT_PROMPT,
  ARTICLE_OUTLINE_PROMPT,
  ARTICLE_DRAFT_PROMPT,
  ARTICLE_JUDGE_PROMPT,
  ARTICLE_REFINE_PROMPT,
} from "./prompts/fallback-prompts.js";

const logger = new Logger("ArticleGraph");

// ============================================================
// State definition
// ============================================================

/**
 * Article generation LangGraph state.
 *
 * Flow: research_extract → outline → draft_article → judge_article →
 *   [refine_article loop, max 3] → set_canonical → save_to_db
 *
 * Phase 1 (P1-05): real LLM implementations using article-* prompts.
 */
export const ArticleState = Annotation.Root({
  runId: Annotation<string>,
  topic: Annotation<string>,
  keywords: Annotation<string[]>({
    reducer: (_, y) => y,
    default: () => [],
  }),
  facts: Annotation<string[]>({
    reducer: (_, y) => y,
    default: () => [],
  }),
  outline: Annotation<ArticleOutlineSection[]>({
    reducer: (_, y) => y,
    default: () => [],
  }),
  draft: Annotation<ArticleContent | null>({
    reducer: (_, y) => y,
    default: () => null,
  }),
  judgeScores: Annotation<ArticleJudgeScores | null>({
    reducer: (_, y) => y,
    default: () => null,
  }),
  judgeFeedback: Annotation<string | null>({
    reducer: (_, y) => y,
    default: () => null,
  }),
  refineCount: Annotation<number>({
    reducer: (_, y) => y,
    default: () => 0,
  }),
  judgeRetried: Annotation<boolean>({
    reducer: (_, y) => y,
    default: () => false,
  }),
  canonicalUrl: Annotation<string | null>({
    reducer: (_, y) => y,
    default: () => null,
  }),
  finalArticle: Annotation<ArticleContent | null>({
    reducer: (_, y) => y,
    default: () => null,
  }),
  error: Annotation<string | null>({
    reducer: (_, y) => y,
    default: () => null,
  }),
  language: Annotation<string>({
    reducer: (_, y) => y,
    default: () => "en",
  }),
  targetNetworks: Annotation<SocialNetwork[]>({
    reducer: (_, y) => y,
    default: () => [SocialNetwork.DEVTO, SocialNetwork.HASHNODE, SocialNetwork.LINKEDIN],
  }),
});

// ============================================================
// Helper: extract JSON object from LLM response
// ============================================================

function extractJson(content: string): unknown | null {
  const match = content.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    return JSON.parse(match[0]);
  } catch {
    return null;
  }
}

// ============================================================
// Real LLM nodes (Phase 1 — P1-05)
// ============================================================

/**
 * research_extract — LLM extracts 8-12 facts about the topic.
 * Uses article-research-extract prompt (chat).
 */
async function researchExtractNode(
  state: typeof ArticleState.State,
  llm: ILlmPort,
  promptPort: IPromptPort | null,
): Promise<Partial<typeof ArticleState.State>> {
  logger.log(`research_extract: topic="${state.topic}"`);

  const variables = {
    topic: state.topic,
    keywords: state.keywords.join(", "),
    language: state.language,
  };

  try {
    const { systemPrompt, userPrompt } = promptPort
      ? await promptPort.getCompiledChat(
          "article-research-extract",
          variables,
          ARTICLE_RESEARCH_EXTRACT_PROMPT,
        )
      : { ...ARTICLE_RESEARCH_EXTRACT_PROMPT };

    const response = await llm.generateChat(systemPrompt, userPrompt, {
      temperature: 0.4,
      role: "facts",
      maxTokens: 2000,
    });

    // Parse numbered list of facts
    const facts = response.content
      .split("\n")
      .map((line) => line.replace(/^\d+[\.\)]\s*/, "").trim())
      .filter(
        (line) =>
          line.length > 10 && !line.startsWith("#") && !line.toLowerCase().startsWith("here"),
      );

    logger.log(`research_extract: extracted ${facts.length} facts`);
    return { facts };
  } catch (error) {
    logger.warn(
      `research_extract failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    return {
      facts: [],
      error: `research_extract: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

/**
 * outline — LLM generates H2/H3 structure from topic + facts.
 * Uses article-outline prompt (text).
 */
async function outlineNode(
  state: typeof ArticleState.State,
  llm: ILlmPort,
  promptPort: IPromptPort | null,
): Promise<Partial<typeof ArticleState.State>> {
  logger.log(`outline: topic="${state.topic}", facts=${state.facts.length}`);

  const variables = {
    topic: state.topic,
    keywords: state.keywords.join(", "),
    facts: state.facts.map((f, i) => `${i + 1}. ${f}`).join("\n"),
    language: state.language,
  };

  try {
    const promptText = promptPort
      ? await promptPort.getCompiledText("article-outline", variables, ARTICLE_OUTLINE_PROMPT)
      : ARTICLE_OUTLINE_PROMPT;

    const response = await llm.generateChat("", promptText, {
      temperature: 0.5,
      role: "outline",
      maxTokens: 2000,
    });

    // Parse markdown outline into ArticleOutlineSection[]
    const outline = parseOutline(response.content);
    logger.log(`outline: generated ${outline.length} sections`);
    return { outline };
  } catch (error) {
    logger.warn(`outline failed: ${error instanceof Error ? error.message : String(error)}`);
    return {
      outline: [],
      error: `outline: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

/**
 * Parse markdown outline into structured sections.
 * Format:
 *   ## Section Heading
 *   - Key point 1
 *   - Key point 2
 *   - Estimated: 300 words
 */
function parseOutline(markdown: string): ArticleOutlineSection[] {
  const sections: ArticleOutlineSection[] = [];
  const lines = markdown.split("\n");
  let current: ArticleOutlineSection | null = null;

  for (const line of lines) {
    const h2 = line.match(/^##\s+(.+)/);
    const h3 = line.match(/^###\s+(.+)/);
    const point = line.match(/^-\s+(.+)/);
    const est = line.match(/estimated:?\s*(\d+)\s*words?/i);

    if (h2?.[1]) {
      if (current) sections.push(current);
      current = { heading: h2[1].trim(), level: 2, keyPoints: [], estimatedWordCount: 300 };
    } else if (h3?.[1] && current) {
      sections.push(current);
      current = { heading: h3[1].trim(), level: 3, keyPoints: [], estimatedWordCount: 200 };
    } else if (point?.[1] && current) {
      current.keyPoints.push(point[1].trim());
    } else if (est?.[1] && current) {
      current.estimatedWordCount = parseInt(est[1], 10) || current.estimatedWordCount;
    }
  }
  if (current) sections.push(current);
  return sections;
}

/**
 * draft_article — LLM writes full markdown article from outline + facts.
 * Uses article-draft prompt (chat).
 */
async function draftArticleNode(
  state: typeof ArticleState.State,
  llm: ILlmPort,
  promptPort: IPromptPort | null,
): Promise<Partial<typeof ArticleState.State>> {
  logger.log(`draft_article: topic="${state.topic}", outline sections=${state.outline.length}`);

  const outlineText = state.outline
    .map(
      (s) =>
        `${"#".repeat(s.level)} ${s.heading}\n${s.keyPoints.map((p) => `- ${p}`).join("\n")}\nEstimated: ${s.estimatedWordCount} words`,
    )
    .join("\n\n");

  const variables = {
    topic: state.topic,
    keywords: state.keywords.join(", "),
    language: state.language,
    outline: outlineText,
    facts: state.facts.map((f, i) => `${i + 1}. ${f}`).join("\n"),
  };

  try {
    const { systemPrompt, userPrompt } = promptPort
      ? await promptPort.getCompiledChat("article-draft", variables, ARTICLE_DRAFT_PROMPT)
      : { ...ARTICLE_DRAFT_PROMPT };

    const response = await llm.generateChat(systemPrompt, userPrompt, {
      temperature: 0.7,
      role: "draft",
      maxTokens: 4000,
    });

    const article = parseArticle(response.content, state.topic, state.keywords);
    logger.log(
      `draft_article: wrote ${article.bodyMarkdown.length} chars, title="${article.title}"`,
    );
    return { draft: article };
  } catch (error) {
    logger.warn(`draft_article failed: ${error instanceof Error ? error.message : String(error)}`);
    return {
      draft: null,
      error: `draft_article: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

/**
 * Parse LLM markdown response into ArticleContent.
 * Extracts H1 title, slug, excerpt, and tags.
 */
function parseArticle(markdown: string, topic: string, keywords: string[]): ArticleContent {
  // Extract H1 title (first # heading)
  const titleMatch = markdown.match(/^#\s+(.+)/m);
  const title = titleMatch?.[1] ? titleMatch[1].trim() : topic;

  // Generate slug from title
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);

  // Extract excerpt from first paragraph after title (first 200 chars)
  const bodyWithoutTitle = markdown.replace(/^#\s+.+\n?/, "");
  const firstPara = bodyWithoutTitle.split("\n\n").find((p) => p.trim().length > 20) ?? "";
  const excerpt = firstPara
    .replace(/[#*\-`]/g, "")
    .trim()
    .slice(0, 200);

  return {
    title,
    slug,
    bodyMarkdown: markdown,
    excerpt,
    tags: keywords.slice(0, 5),
  };
}

/**
 * judge_article — LLM evaluates 5 criteria (0.0-1.0 each).
 * Uses article-judge prompt (text, returns JSON).
 */
async function judgeArticleNode(
  state: typeof ArticleState.State,
  llm: ILlmPort,
  promptPort: IPromptPort | null,
): Promise<Partial<typeof ArticleState.State>> {
  logger.log(`judge_article: topic="${state.topic}", refineCount=${state.refineCount}`);

  if (!state.draft) {
    logger.warn("judge_article: no draft to judge");
    return { judgeScores: null };
  }

  const variables = {
    article: state.draft.bodyMarkdown,
    topic: state.topic,
    keywords: state.keywords.join(", "),
  };

  try {
    const promptText = promptPort
      ? await promptPort.getCompiledText("article-judge", variables, ARTICLE_JUDGE_PROMPT)
      : ARTICLE_JUDGE_PROMPT;

    const response = await llm.generateChat("", promptText, {
      temperature: 0.2,
      role: "judge",
      maxTokens: 1000,
    });

    const parsed = extractJson(response.content);
    if (!parsed || typeof parsed !== "object") {
      logger.warn("judge_article: failed to parse JSON from LLM response");
      return { judgeScores: null };
    }

    const scores = parsed as ArticleJudgeScores;
    // Validate required fields
    const required = [
      "anti_ai_tone",
      "hook_strength",
      "factual_accuracy",
      "structure_quality",
      "seo_optimization",
    ];
    const valid = required.every((k) => typeof scores[k] === "number");
    if (!valid) {
      logger.warn("judge_article: missing or invalid score fields");
      return { judgeScores: null };
    }

    // Build feedback string for refine node
    const feedback = [
      `anti_ai_tone: ${scores.anti_ai_tone} — ${scores.anti_ai_tone_reason}`,
      `hook_strength: ${scores.hook_strength} — ${scores.hook_strength_reason}`,
      `factual_accuracy: ${scores.factual_accuracy} — ${scores.factual_accuracy_reason}`,
      `structure_quality: ${scores.structure_quality} — ${scores.structure_quality_reason}`,
      `seo_optimization: ${scores.seo_optimization} — ${scores.seo_optimization_reason}`,
    ].join("\n");

    logger.log(`judge_article: scores avg=${avgScore(scores).toFixed(2)}`);
    return { judgeScores: scores, judgeFeedback: feedback };
  } catch (error) {
    logger.warn(`judge_article failed: ${error instanceof Error ? error.message : String(error)}`);
    return { judgeScores: null };
  }
}

/**
 * Calculate average score across all 5 dimensions.
 */
function avgScore(scores: ArticleJudgeScores): number {
  const dims = [
    "anti_ai_tone",
    "hook_strength",
    "factual_accuracy",
    "structure_quality",
    "seo_optimization",
  ] as const;
  const values = dims.map((k) => scores[k]).filter((v) => typeof v === "number") as number[];
  if (values.length === 0) return 0;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

/**
 * refine_article — LLM rewrites article based on judge feedback.
 * Uses article-refine prompt (text).
 */
async function refineArticleNode(
  state: typeof ArticleState.State,
  llm: ILlmPort,
  promptPort: IPromptPort | null,
): Promise<Partial<typeof ArticleState.State>> {
  logger.log(`refine_article: topic="${state.topic}", refineCount=${state.refineCount}`);

  if (!state.draft) {
    return { refineCount: state.refineCount + 1 };
  }

  const variables = {
    article: state.draft.bodyMarkdown,
    feedback: state.judgeFeedback ?? "Improve overall quality.",
    topic: state.topic,
    keywords: state.keywords.join(", "),
    language: state.language,
  };

  try {
    const promptText = promptPort
      ? await promptPort.getCompiledText("article-refine", variables, ARTICLE_REFINE_PROMPT)
      : ARTICLE_REFINE_PROMPT;

    const response = await llm.generateChat("", promptText, {
      temperature: 0.6,
      role: "refine",
      maxTokens: 4000,
    });

    const article = parseArticle(response.content, state.topic, state.keywords);
    logger.log(`refine_article: rewrote ${article.bodyMarkdown.length} chars`);
    return {
      draft: article,
      refineCount: state.refineCount + 1,
      judgeRetried: true,
    };
  } catch (error) {
    logger.warn(`refine_article failed: ${error instanceof Error ? error.message : String(error)}`);
    return {
      refineCount: state.refineCount + 1,
      judgeRetried: true,
    };
  }
}

/**
 * set_canonical — set the canonical blog URL via CanonicalUrlService.
 * Phase 0: stub — builds URL but doesn't persist.
 * Phase 1: calls CanonicalUrlService.buildBlogUrl() + setCanonical().
 */
async function setCanonicalNode(
  state: typeof ArticleState.State,
  canonicalService: CanonicalUrlService,
): Promise<Partial<typeof ArticleState.State>> {
  const slug = state.draft?.slug ?? canonicalService.slugify(state.topic);
  const canonicalUrl = canonicalService.buildBlogUrl(slug);
  logger.log(`set_canonical: ${canonicalUrl}`);
  return { canonicalUrl, finalArticle: state.draft };
}

/**
 * save_to_db — format graph state for persistence.
 * Like the social graph's save_to_db, this is a misnomer — it only formats
 * state. Real Prisma persistence happens after graph.invoke() returns,
 * in GenerationService.
 */
async function saveToDbNode(
  state: typeof ArticleState.State,
): Promise<Partial<typeof ArticleState.State>> {
  logger.log(`save_to_db: topic="${state.topic}", canonical=${state.canonicalUrl}`);
  // No DB write here — GenerationService handles persistence after invoke()
  return {};
}

// ============================================================
// Conditional edge: judge → refine or set_canonical
// ============================================================

const MAX_REFINES = 3;
const JUDGE_THRESHOLD = 0.7; // Phase 1: make configurable via env

/**
 * Decide whether to refine or proceed to set_canonical.
 * If average judge score < threshold AND refineCount < MAX_REFINES → refine.
 * Otherwise → set_canonical.
 */
function judgeRouter(state: typeof ArticleState.State): "refine_article" | "set_canonical" {
  if (!state.judgeScores) return "set_canonical";

  const dims = [
    "anti_ai_tone",
    "hook_strength",
    "factual_accuracy",
    "structure_quality",
    "seo_optimization",
  ] as const;
  const values = dims
    .map((k) => state.judgeScores![k])
    .filter((v) => typeof v === "number") as number[];
  if (values.length === 0) return "set_canonical";

  const avg = values.reduce((a, b) => a + b, 0) / values.length;

  if (avg < JUDGE_THRESHOLD && state.refineCount < MAX_REFINES) {
    logger.log(
      `judge_router: avg=${avg.toFixed(2)} < ${JUDGE_THRESHOLD}, refining (count=${state.refineCount + 1})`,
    );
    return "refine_article";
  }

  logger.log(
    `judge_router: avg=${avg.toFixed(2)} ≥ ${JUDGE_THRESHOLD}, proceeding to set_canonical`,
  );
  return "set_canonical";
}

// ============================================================
// Graph builder
// ============================================================

interface ArticleGraphDependencies {
  llm: ILlmPort;
  promptPort: IPromptPort | null;
  canonicalService: CanonicalUrlService;
}

/**
 * Build the article generation LangGraph.
 *
 * Nodes (7):
 *   research_extract → outline → draft_article → judge_article →
 *   [refine_article loop] → set_canonical → save_to_db
 *
 * Phase 0: all nodes are stubs. Phase 1 (P1-05): real LLM implementations.
 *
 * @returns Compiled StateGraph ready for `.invoke(state, config)`.
 */
export function buildArticleGraph(deps: ArticleGraphDependencies) {
  const { llm, promptPort, canonicalService } = deps;

  const graph = new StateGraph(ArticleState)
    .addNode("research_extract", (s: typeof ArticleState.State) =>
      researchExtractNode(s, llm, promptPort),
    )
    .addNode("build_outline", (s: typeof ArticleState.State) => outlineNode(s, llm, promptPort))
    .addNode("draft_article", (s: typeof ArticleState.State) =>
      draftArticleNode(s, llm, promptPort),
    )
    .addNode("judge_article", (s: typeof ArticleState.State) =>
      judgeArticleNode(s, llm, promptPort),
    )
    .addNode("refine_article", (s: typeof ArticleState.State) =>
      refineArticleNode(s, llm, promptPort),
    )
    .addNode("set_canonical", (s: typeof ArticleState.State) =>
      setCanonicalNode(s, canonicalService),
    )
    .addNode("save_to_db", (s: typeof ArticleState.State) => saveToDbNode(s))
    .addEdge(START, "research_extract")
    .addEdge("research_extract", "build_outline")
    .addEdge("build_outline", "draft_article")
    .addEdge("draft_article", "judge_article")
    .addConditionalEdges("judge_article", judgeRouter)
    .addEdge("refine_article", "judge_article")
    .addEdge("set_canonical", "save_to_db")
    .addEdge("save_to_db", END);

  return graph.compile();
}

/**
 * Create initial article graph state from generation options.
 */
export function createArticleInitialState(
  options: GenerateArticleOptions,
  runId: string,
): typeof ArticleState.State {
  return {
    runId,
    topic: options.topic,
    keywords: options.keywords ?? [],
    facts: [],
    outline: [],
    draft: null,
    judgeScores: null,
    judgeFeedback: null,
    refineCount: 0,
    judgeRetried: false,
    canonicalUrl: null,
    finalArticle: null,
    error: null,
    // English-only article generation regardless of the requested language.
    language: "en",
    targetNetworks: options.targetNetworks ?? [
      SocialNetwork.DEVTO,
      SocialNetwork.HASHNODE,
      SocialNetwork.LINKEDIN,
    ],
  };
}
