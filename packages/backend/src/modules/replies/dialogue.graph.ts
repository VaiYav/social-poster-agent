/**
 * DialogueGraph — LangGraph state machine for reply/comment conversation threads.
 *
 * Flow: START → classify → decide → END
 *   - classify: calls QuestionClassifierService on the last user message
 *   - decide: builds context from the whole conversation and asks the LLM
 *     whether to reply, skip, or escalate. Enforces the max-depth hard limit
 *     and validates script/language on generated replies.
 *
 * Conversation state is rebuilt from the DB on every monitoring cycle; the
 * graph itself is short-lived and can be compiled with or without a checkpointer.
 */

import { StateGraph, START, END, Annotation } from '@langchain/langgraph';
import type { ILlmPort, LlmResponse } from '../../domain/ports/llm.port.js';
import { IPromptPort } from '../../domain/ports/prompt.port.js';
import { sanitizeUntrustedInput } from '../../infrastructure/llm/sanitize-untrusted-input.js';
import { matchesScript, normalizeLanguage } from '../../infrastructure/util/script-check.js';
import { interpolate } from '../../domain/prompt-interpolation.js';
import { REPLY_DECISION_PROMPT } from './prompts/reply-decision.prompt.js';
import type { QuestionClassification, QuestionClassifierService } from './question-classifier.service.js';
import type { CommentTone, ToneAnalyzerService } from './tone-analyzer.service.js';

// ── State Definition ───────────────────────────────────────────────────────

export interface DialogueMessage {
  role: 'user' | 'assistant';
  author: string;
  text: string;
  commentId: string;
  depth: number;
  isQuestion?: boolean;
  questionType?: string | null;
  tone?: CommentTone;
}

export interface DialogueDecision {
  action: 'auto_reply' | 'human_review' | 'skip';
  reason: string;
  replyText?: string;
  reviewReason?: string;
  detectedLanguage?: string;
  targetCommentId?: string;
  targetCommentDbId?: string;
}

export const DialogueState = Annotation.Root({
  conversationId: Annotation<string>({
    reducer: (_, next) => next,
    default: () => '',
  }),
  postId: Annotation<string>({
    reducer: (_, next) => next,
    default: () => '',
  }),
  network: Annotation<string>({
    reducer: (_, next) => next,
    default: () => '',
  }),
  postContent: Annotation<string>({
    reducer: (_, next) => next,
    default: () => '',
  }),
  detectedLanguage: Annotation<string>({
    reducer: (_, next) => next,
    default: () => 'en',
  }),
  maxDepth: Annotation<number>({
    reducer: (_, next) => next,
    default: () => 3,
  }),
  autoReplyComplexity: Annotation<string>({
    reducer: (_, next) => next,
    default: () => 'medium',
  }),
  messages: Annotation<DialogueMessage[]>({
    reducer: (_, next) => next,
    default: () => [],
  }),
  classification: Annotation<QuestionClassification | null>({
    reducer: (_, next) => next,
    default: () => null,
  }),
  decision: Annotation<DialogueDecision | null>({
    reducer: (_, next) => next,
    default: () => null,
  }),
  error: Annotation<string | null>({
    reducer: (_, next) => next,
    default: () => null,
  }),
  tone: Annotation<CommentTone>({
    reducer: (_, next) => next,
    default: () => 'neutral',
  }),
});

export type DialogueStateType = typeof DialogueState.State;

// ── Dependencies (injected via factory) ─────────────────────────────────────

export interface DialogueGraphDeps {
  llm: ILlmPort;
  questionClassifier: QuestionClassifierService;
  toneAnalyzer: ToneAnalyzerService;
  promptPort?: IPromptPort;
  repliesTemperature?: number;
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function formatConversationContext(messages: DialogueMessage[]): string {
  if (messages.length === 0) return 'No previous messages.';
  return messages
    .map((m) => {
      const prefix = m.role === 'assistant' ? 'You' : `@${sanitizeUntrustedInput(m.author, 40)}`;
      return `${prefix}: "${sanitizeUntrustedInput(m.text, 280)}"`;
    })
    .join('\n');
}

function findLastUserMessage(messages: DialogueMessage[]): DialogueMessage | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]!.role === 'user') return messages[i]!;
  }
  return null;
}

function getCurrentDepth(messages: DialogueMessage[]): number {
  return messages.filter((m) => m.role === 'assistant').length;
}

async function getCompiledText(
  promptPort: IPromptPort | undefined,
  name: string,
  variables: Record<string, string>,
  fallback: string,
): Promise<string> {
  if (promptPort) {
    return promptPort.getCompiledText(name, variables, fallback);
  }
  return interpolate(fallback, variables);
}

function parseDecisionJson(raw: string): Partial<DialogueDecision> | null {
  const jsonMatch = raw.match(/\{[\s\S]*\}/);
  if (!jsonMatch) return null;
  try {
    return JSON.parse(jsonMatch[0]) as Partial<DialogueDecision>;
  } catch {
    return null;
  }
}

// ── Nodes ───────────────────────────────────────────────────────────────────

function classifyNode(deps: DialogueGraphDeps) {
  return async (state: DialogueStateType): Promise<Partial<DialogueStateType>> => {
    const lastUser = findLastUserMessage(state.messages);
    if (!lastUser) {
      return { error: 'No user message to classify' };
    }
    const [classification, tone] = await Promise.all([
      deps.questionClassifier.classify(lastUser.text, state.detectedLanguage),
      deps.toneAnalyzer.detectTone(lastUser.text, state.detectedLanguage),
    ]);
    return { classification, tone: tone.tone };
  };
}

function decideNode(deps: DialogueGraphDeps) {
  return async (state: DialogueStateType): Promise<Partial<DialogueStateType>> => {
    if (state.error) {
      return { decision: { action: 'skip', reason: `Dialogue error: ${state.error}` } };
    }

    const lastUser = findLastUserMessage(state.messages);
    if (!lastUser) {
      return { decision: { action: 'skip', reason: 'No user message to reply to' } };
    }

    const currentDepth = getCurrentDepth(state.messages);

    // Hard depth limit: do not burn an LLM call if we already hit the ceiling.
    if (currentDepth >= state.maxDepth) {
      return {
        decision: {
          action: 'skip',
          reason: `Max conversation depth reached (${currentDepth}/${state.maxDepth})`,
        },
      };
    }

    const classification = state.classification;
    const systemPrompt = await getCompiledText(
      deps.promptPort,
      'reply-decision',
      {
        postContent: state.postContent.slice(0, 400),
        conversationContext: formatConversationContext(state.messages),
        depth: String(currentDepth),
        maxDepth: String(state.maxDepth),
        isQuestion: String(classification?.isQuestion ?? false),
        questionType: classification?.questionType ?? 'none',
        detectedLanguage: state.detectedLanguage,
        network: state.network,
        tone: state.tone ?? 'neutral',
      },
      REPLY_DECISION_PROMPT,
    );

    const userPrompt = `Post: "${state.postContent.slice(0, 300)}"

Latest comment from @${sanitizeUntrustedInput(lastUser.author, 60)}: "${sanitizeUntrustedInput(lastUser.text)}"

Return JSON only.`;

    let response: LlmResponse;
    try {
      response = await deps.llm.generateChat(systemPrompt, userPrompt, {
        temperature: deps.repliesTemperature,
        role: 'utility',
      });
    } catch (err) {
      return {
        decision: {
          action: 'skip',
          reason: `LLM reply decision failed: ${(err as Error).message}`,
        },
      };
    }

    const parsed = parseDecisionJson(response.content);
    if (!parsed) {
      return {
        decision: {
          action: 'skip',
          reason: 'LLM reply decision returned no valid JSON',
        },
      };
    }

    // Normalize and validate action
    let action = parsed.action;
    if (action !== 'auto_reply' && action !== 'human_review' && action !== 'skip') {
      action = 'human_review';
      parsed.reviewReason = parsed.reviewReason ?? 'LLM returned invalid action';
    }

    // Validate replyText exists for auto_reply
    if (action === 'auto_reply' && (!parsed.replyText || typeof parsed.replyText !== 'string')) {
      action = 'human_review';
      parsed.reviewReason = parsed.reviewReason ?? 'LLM auto_reply missing replyText';
    }

    // Post-validation: script must match detected language.
    // The deterministic detector is the ground truth; if the LLM echoed a
    // different language code, use the detector's label for validation and
    // correct the decision's detectedLanguage.
    if (action === 'auto_reply' && parsed.replyText) {
      const llmLang = normalizeLanguage(parsed.detectedLanguage);
      const detectorLang = normalizeLanguage(state.detectedLanguage);
      const lang = llmLang === detectorLang ? llmLang : detectorLang;
      if (llmLang !== detectorLang) {
        parsed.detectedLanguage = lang;
      }
      if (!matchesScript(parsed.replyText, lang)) {
        action = 'human_review';
        parsed.reviewReason = `Reply script does not match detected language (${lang}) — requires human review`;
      }
    }

    // Complexity threshold check (matches legacy RepliesMonitor logic)
    if (action === 'auto_reply' && state.autoReplyComplexity !== 'high') {
      const isComplex =
        lastUser.text.length > 200 || (lastUser.text.match(/\?/g)?.length ?? 0) > 1;
      if (isComplex && state.autoReplyComplexity === 'low') {
        action = 'human_review';
        parsed.reviewReason = `Complex comment exceeds auto-reply threshold (${state.autoReplyComplexity})`;
      }
    }

    const decision: DialogueDecision = {
      action,
      reason: parsed.reason ?? 'no reason given',
      replyText: action === 'auto_reply' ? parsed.replyText : undefined,
      reviewReason: action === 'human_review' ? parsed.reviewReason ?? parsed.reason : undefined,
      detectedLanguage: normalizeLanguage(parsed.detectedLanguage ?? state.detectedLanguage),
      targetCommentId: lastUser.commentId,
      targetCommentDbId: state.postId,
    };

    return { decision };
  };
}

// ── Graph Builder ───────────────────────────────────────────────────────────

export function buildDialogueGraph(deps: DialogueGraphDeps) {
  const graph = new StateGraph(DialogueState)
    .addNode('classify', classifyNode(deps))
    .addNode('decide', decideNode(deps))
    .addEdge(START, 'classify')
    .addEdge('classify', 'decide')
    .addEdge('decide', END);

  return graph;
}

/**
 * Compile the dialogue graph. The graph is stateless by design — conversation
 * state is rebuilt from the DB on each monitoring cycle. A LangGraph checkpointer
 * can be wired in later by passing `compileOpts` here.
 */
export function compileDialogueGraph(deps: DialogueGraphDeps) {
  const builder = buildDialogueGraph(deps);
  return builder.compile();
}

/**
 * Create initial state for a single conversation turn.
 */
export function createDialogueState(input: {
  conversationId: string;
  postId: string;
  network: string;
  postContent: string;
  detectedLanguage: string;
  maxDepth: number;
  autoReplyComplexity: 'low' | 'medium' | 'high';
  messages: DialogueMessage[];
  tone?: CommentTone;
}): DialogueStateType {
  return {
    conversationId: input.conversationId,
    postId: input.postId,
    network: input.network,
    postContent: input.postContent,
    detectedLanguage: input.detectedLanguage,
    maxDepth: input.maxDepth,
    autoReplyComplexity: input.autoReplyComplexity,
    messages: input.messages,
    classification: null,
    decision: null,
    error: null,
    tone: input.tone ?? 'neutral',
  };
}
