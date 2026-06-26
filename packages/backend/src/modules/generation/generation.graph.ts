import { StateGraph, END, START, Annotation } from '@langchain/langgraph';
import type { ILlmPort } from '../../domain/ports/llm.port.js';
import type { ContentTopic } from '@spa/shared';
import { SocialNetwork } from '@prisma/client';
import { Logger } from '@nestjs/common';

const logger = new Logger('GenerationGraph');

// ============================================================
// Types
// ============================================================

/** Per-network generation result (draft → critique → refine pipeline). */
interface NetworkResult {
  angle: string;
  hook: string;
  draft: string;
  critique: string;
  refined: string;
}

/** Output of the full graph — one entry per target network. */
export interface GeneratedPost {
  network: SocialNetwork;
  content: string;
  hook: string;
  angle: string;
  model: string;
}

// ============================================================
// State — the data flowing through the graph
// ============================================================

/**
 * Generation workflow state (§10.3 parallel per-network graph).
 *
 * Flow:
 *   START → research_extract → hook_generation → angle_per_network
 *                                                          ↓
 *                  ┌──────────────────┬────────────────────┘
 *                  ▼                  ▼                    ▼
 *             draft_x          draft_threads        draft_facebook
 *                  │                  │                    │
 *                  ▼                  ▼                    ▼
 *            critique_x       critique_threads      critique_facebook
 *                  │                  │                    │
 *                  ▼                  ▼                    ▼
 *             refine_x          refine_threads        refine_facebook
 *                  │                  │                    │
 *                  └──┬───────────────┴────────────────────┘
 *                     ▼
 *              [save_to_db: 3 Posts]
 */
export const GenerationState = Annotation.Root({
  topic: Annotation<ContentTopic>,
  targetNetworks: Annotation<SocialNetwork[]>,
  brandVoice: Annotation<string>,
  // Accumulated outputs
  facts: Annotation<string[]>,
  hooks: Annotation<string[]>, // 3-5 hook variants from hook_generation
  // Per-network results (keyed by network name) — reducer merges concurrent updates from parallel nodes
  results: Annotation<Record<string, NetworkResult>>({
    reducer: (old: Record<string, NetworkResult>, update: Record<string, NetworkResult>) => ({ ...old, ...update }),
    default: () => ({} as Record<string, NetworkResult>),
  }),
  // LLM metadata
  model: Annotation<string>,
  // Final outputs
  posts: Annotation<GeneratedPost[]>,
  // Error tracking
  error: Annotation<string | null>,
});

export type GenerationStateType = typeof GenerationState.State;

// ============================================================
// Network config
// ============================================================

/**
 * Per-network character limits.
 * CONSTITUTION §11.3: FB ~63k chars max, but for marketing ≤500.
 * We enforce the marketing limit (500) — long FB posts get low engagement.
 */
const NETWORK_LIMITS: Record<SocialNetwork, number> = {
  [SocialNetwork.X]: 280,
  [SocialNetwork.THREADS]: 500,
  [SocialNetwork.FACEBOOK]: 500, // §11.3: marketing ≤500
};

const NETWORK_TONE: Record<SocialNetwork, string> = {
  [SocialNetwork.X]: 'Punchy, hook-first, confident, conversation-starter. 1-2 hashtags max.',
  [SocialNetwork.THREADS]: 'Narrative, storytelling, warmer, like a knowledgeable friend. 2-3 hashtags.',
  [SocialNetwork.FACEBOOK]: 'Conversational, community-oriented, end with a question for engagement. 3-4 hashtags.',
};

const NETWORK_ANGLE: Record<SocialNetwork, string> = {
  [SocialNetwork.X]: 'punchy + hook-first — bold claim or counter-intuitive observation, max impact in 280 chars',
  [SocialNetwork.THREADS]: 'narrative + storytelling — personal angle, warmer, like sharing a discovery with a friend',
  [SocialNetwork.FACEBOOK]: 'conversational + question-end — community angle, invite discussion, end with a question',
};

// ============================================================
// Nodes — each node is a step in the workflow
// ============================================================

/**
 * Node 1: research_extract — extract key facts from the topic.
 */
async function researchExtractNode(state: GenerationStateType): Promise<Partial<GenerationStateType>> {
  const facts = state.topic.facts.length > 0
    ? state.topic.facts
    : ['No specific facts available — generate from general knowledge.'];

  return { facts };
}

/**
 * Node 2: hook_generation — generate 3-5 hook variants (§10.3).
 * Variants: question / bold statement / counter-intuitive observation.
 */
async function hookGenerationNode(
  state: GenerationStateType,
  llm: ILlmPort,
): Promise<Partial<GenerationStateType>> {
  const systemPrompt = `You are a social media hook writer for My Zodiac AI, an AI-powered astrology platform.
BRAND VOICE: ${state.brandVoice}
Generate 3-5 different hooks (first lines) for posts about "${state.topic.topic}".
Each hook must use a DIFFERENT technique:
  1. A provocative question
  2. A bold statement / claim
  3. A counter-intuitive observation
  4. (optional) A personal story opener
  5. (optional) A data point / fact-led opener

No "Did you know" — vary your hooks. Each hook on its own line.
Return ONLY the hooks, one per line, numbered 1-5.`;

  const userPrompt = `Topic: ${state.topic.topic}
Key facts: ${state.facts.join(', ')}
Keywords: ${state.topic.keywords.join(', ')}

Hooks:`;

  let response;
  try {
    response = await llm.generateChat(systemPrompt, userPrompt, { temperature: 0.9 });
  } catch (err) {
    logger.error(`hook_generation LLM call failed: ${(err as Error).message}`);
    throw err; // Re-throw — GenerationService.generate() catches per-topic
  }
  const hooks = response.content
    .split('\n')
    .map((line) => line.replace(/^\d+[\.\)]\s*/, '').trim())
    .filter((line) => line.length > 0)
    .slice(0, 5);

  // Ensure at least 3 hooks (fallback if LLM returned fewer)
  while (hooks.length < 3) {
    hooks.push(`Discover what ${state.topic.topic} means for you.`);
  }

  return { hooks, model: response.model };
}

/**
 * Node 3: angle_per_network — assign a different hook + angle to each network.
 *
 * §10.3: "Per-network angle = разный контент, не адаптация одного."
 * Each network gets a DIFFERENT hook from the pool, with a network-specific angle.
 */
function anglePerNetworkNode(state: GenerationStateType): Partial<GenerationStateType> {
  const results: Record<string, NetworkResult> = {};

  const networks = state.targetNetworks;
  for (let i = 0; i < networks.length; i++) {
    const net = networks[i];
    if (!net) continue;
    // Assign different hooks to different networks (cycle through available hooks)
    const hook = state.hooks[i % state.hooks.length] ?? state.hooks[0] ?? '';
    const angle = NETWORK_ANGLE[net];

    results[net] = {
      angle,
      hook,
      draft: '',
      critique: '',
      refined: '',
    };
  }

  return { results };
}

/**
 * Create a draft generation node for a specific network.
 * Each network gets its own node so LangGraph can run them in parallel.
 */
function makeDraftNode(network: SocialNetwork) {
  return async function draftNode(
    state: GenerationStateType,
    llm: ILlmPort,
  ): Promise<Partial<GenerationStateType>> {
    const netResult = state.results[network];
    if (!netResult) return {};

    const charLimit = NETWORK_LIMITS[network];
    const tone = NETWORK_TONE[network];

    const systemPrompt = `You are a social media content creator for My Zodiac AI.
BRAND VOICE: ${state.brandVoice}
Generate a ${network} post using the provided hook and angle. Fit within ${charLimit} characters.
Include 1-2 relevant hashtags. End with a soft CTA to myzodiacai.com when appropriate.
Never use fear-mongering, absolute predictions, or medical/financial advice.
Return ONLY the post text, nothing else.`;

    const userPrompt = `Topic: ${state.topic.topic}
Hook: ${netResult.hook}
Angle: ${netResult.angle}
Key facts: ${state.facts.join('\n- ')}
Keywords: ${state.topic.keywords.join(', ')}
Tone: ${tone}
Character limit: ${charLimit}

${state.topic.outline ? `Outline:\n${state.topic.outline.map((o: { heading: string }) => `- ${o.heading}`).join('\n')}` : ''}

Post text:`;

    let response;
    try {
      response = await llm.generateChat(systemPrompt, userPrompt, { temperature: 0.7 });
    } catch (err) {
      logger.error(`draft_${network} LLM call failed: ${(err as Error).message}`);
      throw err; // Re-throw — GenerationService.generate() catches per-topic
    }

    // B5: Return ONLY the updated network — the results reducer merges concurrent updates
    return {
      results: {
        [network]: {
          ...netResult,
          draft: response.content.trim(),
        },
      },
    };
  };
}

/**
 * Create a critique node for a specific network.
 */
function makeCritiqueNode(network: SocialNetwork) {
  return async function critiqueNode(
    state: GenerationStateType,
    llm: ILlmPort,
  ): Promise<Partial<GenerationStateType>> {
    const netResult = state.results[network];
    if (!netResult) return {};

    const charLimit = NETWORK_LIMITS[network];

    const critiquePrompt = `Critique this ${network} post. Check:
1. Is it within ${charLimit} characters? (current: ${netResult.draft.length})
2. Is it on-brand? (mystical-but-grounded, accessible, empowering)
3. No fear-mongering or absolute predictions?
4. Has a hook in the first line?
5. Has 1-2 relevant hashtags?
6. Is the tone appropriate for ${network}?
7. Does it match the angle: "${netResult.angle}"?

Draft:
"${netResult.draft}"

Return a brief critique (2-3 sentences). If the draft is good, say "GOOD — no changes needed."`;

    let response;
    try {
      response = await llm.generateChat('', critiquePrompt, { temperature: 0.3 });
    } catch (err) {
      logger.error(`critique_${network} LLM call failed: ${(err as Error).message}`);
      throw err; // Re-throw — GenerationService.generate() catches per-topic
    }

    // B5: Return ONLY the updated network — reducer merges concurrent updates
    return {
      results: {
        [network]: {
          ...netResult,
          critique: response.content.trim(),
        },
      },
    };
  };
}

/**
 * Create a refine node for a specific network.
 */
function makeRefineNode(network: SocialNetwork) {
  return async function refineNode(
    state: GenerationStateType,
    llm: ILlmPort,
  ): Promise<Partial<GenerationStateType>> {
    const netResult = state.results[network];
    if (!netResult) return {};

    // If critique says it's good, skip refinement (case-insensitive match)
    const critiqueLower = netResult.critique.toLowerCase();
    if (critiqueLower.includes('good') || critiqueLower.includes('no changes')) {
      return {
        results: {
          [network]: { ...netResult, refined: netResult.draft },
        },
      };
    }

    const charLimit = NETWORK_LIMITS[network];

    const refinePrompt = `Refine this ${network} post based on the critique.

Draft:
"${netResult.draft}"

Critique:
${netResult.critique}

Character limit: ${charLimit}
Return ONLY the refined post text, nothing else.`;

    let response;
    try {
      response = await llm.generateChat('', refinePrompt, { temperature: 0.5 });
    } catch (err) {
      logger.error(`refine_${network} LLM call failed: ${(err as Error).message}`);
      throw err; // Re-throw — GenerationService.generate() catches per-topic
    }

    // B5: Return ONLY the updated network — reducer merges concurrent updates
    return {
      results: {
        [network]: {
          ...netResult,
          refined: response.content.trim(),
        },
      },
    };
  };
}

/**
 * Node 7: save_to_db — collect all refined posts into final output.
 * (Actual DB save happens in GenerationService — this node just formats the output.)
 */
function saveToDbNode(state: GenerationStateType): Partial<GenerationStateType> {
  const posts: GeneratedPost[] = [];

  for (const network of state.targetNetworks) {
    const netResult = state.results[network];
    if (!netResult) continue;

    const content = netResult.refined || netResult.draft;
    if (!content) continue;

    posts.push({
      network,
      content,
      hook: netResult.hook,
      angle: netResult.angle,
      model: state.model,
    });
  }

  return { posts };
}

// ============================================================
// Graph builder — assembles the 7-step parallel workflow (§10.3)
// ============================================================

/**
 * Build the LangGraph generation workflow with per-network parallel fan-out.
 *
 * Flow:
 *   START → research_extract → hook_generation → angle_per_network
 *     → [draft_x || draft_threads || draft_facebook]  (parallel)
 *     → [critique_x || critique_threads || critique_facebook]  (parallel)
 *     → [refine_x || refine_threads || refine_facebook]  (parallel)
 *     → save_to_db → END
 */
export function buildGenerationGraph(llm: ILlmPort) {
  const logger = new Logger('GenerationGraph');

  const graph = new StateGraph(GenerationState)
    // Step 1: research_extract
    .addNode('research_extract', async (state: GenerationStateType) => {
      logger.debug('Node: research_extract');
      return researchExtractNode(state);
    })
    // Step 2: hook_generation (3-5 variants)
    .addNode('hook_generation', async (state: GenerationStateType) => {
      logger.debug('Node: hook_generation');
      return hookGenerationNode(state, llm);
    })
    // Step 3: angle_per_network (assign hooks + angles)
    .addNode('angle_per_network', async (state: GenerationStateType) => {
      logger.debug('Node: angle_per_network');
      return anglePerNetworkNode(state);
    })
    // Step 4: parallel draft per network
    .addNode('draft_x', async (state: GenerationStateType) => {
      logger.debug('Node: draft_x');
      return makeDraftNode(SocialNetwork.X)(state, llm);
    })
    .addNode('draft_threads', async (state: GenerationStateType) => {
      logger.debug('Node: draft_threads');
      return makeDraftNode(SocialNetwork.THREADS)(state, llm);
    })
    .addNode('draft_facebook', async (state: GenerationStateType) => {
      logger.debug('Node: draft_facebook');
      return makeDraftNode(SocialNetwork.FACEBOOK)(state, llm);
    })
    // Step 5: parallel critique per network
    .addNode('critique_x', async (state: GenerationStateType) => {
      logger.debug('Node: critique_x');
      return makeCritiqueNode(SocialNetwork.X)(state, llm);
    })
    .addNode('critique_threads', async (state: GenerationStateType) => {
      logger.debug('Node: critique_threads');
      return makeCritiqueNode(SocialNetwork.THREADS)(state, llm);
    })
    .addNode('critique_facebook', async (state: GenerationStateType) => {
      logger.debug('Node: critique_facebook');
      return makeCritiqueNode(SocialNetwork.FACEBOOK)(state, llm);
    })
    // Step 6: parallel refine per network
    .addNode('refine_x', async (state: GenerationStateType) => {
      logger.debug('Node: refine_x');
      return makeRefineNode(SocialNetwork.X)(state, llm);
    })
    .addNode('refine_threads', async (state: GenerationStateType) => {
      logger.debug('Node: refine_threads');
      return makeRefineNode(SocialNetwork.THREADS)(state, llm);
    })
    .addNode('refine_facebook', async (state: GenerationStateType) => {
      logger.debug('Node: refine_facebook');
      return makeRefineNode(SocialNetwork.FACEBOOK)(state, llm);
    })
    // Step 7: save_to_db (collect outputs)
    .addNode('save_to_db', async (state: GenerationStateType) => {
      logger.debug('Node: save_to_db');
      return saveToDbNode(state);
    })
    // Edges: linear through step 3
    .addEdge(START, 'research_extract')
    .addEdge('research_extract', 'hook_generation')
    .addEdge('hook_generation', 'angle_per_network')
    // Fan out: angle → parallel drafts
    .addEdge('angle_per_network', 'draft_x')
    .addEdge('angle_per_network', 'draft_threads')
    .addEdge('angle_per_network', 'draft_facebook')
    // Drafts → critiques (per network)
    .addEdge('draft_x', 'critique_x')
    .addEdge('draft_threads', 'critique_threads')
    .addEdge('draft_facebook', 'critique_facebook')
    // Critiques → refines (per network)
    .addEdge('critique_x', 'refine_x')
    .addEdge('critique_threads', 'refine_threads')
    .addEdge('critique_facebook', 'refine_facebook')
    // Fan in: all refines → save_to_db
    .addEdge('refine_x', 'save_to_db')
    .addEdge('refine_threads', 'save_to_db')
    .addEdge('refine_facebook', 'save_to_db')
    .addEdge('save_to_db', END);

  return graph;
}

/**
 * Prepare initial state for a generation run.
 * One graph invocation generates posts for ALL target networks in parallel.
 */
export function createInitialState(
  topic: ContentTopic,
  targetNetworks: SocialNetwork[],
  brandVoice: string,
): GenerationStateType {
  return {
    topic,
    targetNetworks,
    brandVoice,
    facts: [],
    hooks: [],
    results: {},
    model: '',
    posts: [],
    error: null,
  };
}
