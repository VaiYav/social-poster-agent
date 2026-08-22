/**
 * P4: Thread Depth Service — configurable multi-tweet thread expansion.
 *
 * Replaces the fixed 2-post F2 multi-stage posting with a configurable
 * thread depth (1-5 tweets). The service decides:
 *   - Whether to expand a post into a thread (based on content richness)
 *   - How many tweets the thread should have
 *   - What angle each continuation tweet takes
 *
 * Decision factors:
 *   - Content richness: posts with 3+ key facts → deeper threads
 *   - Network: X supports threads natively; Threads (Meta) supports threads;
 *     Facebook does NOT support threads (always single post)
 *   - User override: `threadDepth` parameter in generation request
 *   - Topic type: educational/product pillars → deeper threads
 *
 * The controller generates all continuation tweets in a single LLM call
 * (batch prompt) to ensure narrative coherence across the thread.
 */

import { Injectable, Logger, Optional } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import type { ILlmPort } from "../../domain/ports/llm.port.js";
import { SocialNetwork } from "../../generated/prisma/client";
import { classifyPillar } from "./content-pillar.tracker.js";
import { truncateForThread } from "./thread-limit.js";

/** Maximum thread depth (tweet count including root). */
const MAX_THREAD_DEPTH = 5;
/** Default thread depth when no override is provided. */
const DEFAULT_THREAD_DEPTH = 2;
/** Minimum key facts to justify a 3+ tweet thread. */
const MIN_FACTS_FOR_DEEP_THREAD = 3;

/** Per-network max thread depth (Facebook = 1, no threads). */
const NETWORK_MAX_DEPTH: Partial<Record<SocialNetwork, number>> = {
  [SocialNetwork.X]: MAX_THREAD_DEPTH,
  [SocialNetwork.THREADS]: MAX_THREAD_DEPTH,
  [SocialNetwork.FACEBOOK]: 1, // Facebook doesn't support threads
};

/**
 * A single continuation tweet in a thread.
 */
export interface ThreadContinuationTweet {
  /** 0-based position in the thread (0 = root, 1+ = continuations). */
  position: number;
  /** Tweet text. */
  content: string;
}

/**
 * Result of thread depth planning.
 */
export interface ThreadPlan {
  /** Total number of tweets including root. 1 = no thread (single post). */
  depth: number;
  /** Continuation tweets (empty when depth=1). */
  continuations: ThreadContinuationTweet[];
  /** Why this depth was chosen — for logging. */
  reasoning: string;
}

@Injectable()
export class ThreadDepthService {
  private readonly logger = new Logger(ThreadDepthService.name);
  private readonly defaultDepth: number;

  constructor(
    private readonly configService: ConfigService,
    @Optional() private readonly llm?: ILlmPort,
  ) {
    const envDepth = Number(
      this.configService.get<string>("THREAD_DEFAULT_DEPTH", String(DEFAULT_THREAD_DEPTH)),
    );
    this.defaultDepth = Math.max(
      1,
      Math.min(MAX_THREAD_DEPTH, isNaN(envDepth) ? DEFAULT_THREAD_DEPTH : envDepth),
    );
  }

  /**
   * Decide the thread depth for a post based on content richness, network,
   * and user override.
   *
   * @param network      Target network
   * @param rootContent  Root post text
   * @param keyFacts     Key facts extracted from the content source
   * @param topic        Original topic
   * @param keywords     Topic keywords
   * @param userOverride Optional user-specified depth (1-5)
   * @returns Thread plan with continuation tweets
   */
  async planThread(
    network: SocialNetwork,
    rootContent: string,
    keyFacts: string[],
    topic: string,
    keywords: string[],
    userOverride?: number,
  ): Promise<ThreadPlan> {
    const networkMax = NETWORK_MAX_DEPTH[network] ?? 1;
    if (networkMax === 1) {
      return { depth: 1, continuations: [], reasoning: "Facebook does not support threads" };
    }

    if (userOverride !== undefined && userOverride > 0) {
      const depth = Math.min(userOverride, networkMax);
      if (depth === 1) {
        return { depth: 1, continuations: [], reasoning: "User override: single post" };
      }
      return this.generateContinuations(
        depth,
        rootContent,
        keyFacts,
        topic,
        keywords,
        "User override",
      );
    }

    const pillar = classifyPillar(topic, keywords);
    const factsCount = keyFacts.length;

    let targetDepth = this.defaultDepth;

    if (
      factsCount >= MIN_FACTS_FOR_DEEP_THREAD &&
      (pillar === "educational" || pillar === "product")
    ) {
      targetDepth = Math.min(MAX_THREAD_DEPTH, Math.min(factsCount + 1, 5));
    } else if (factsCount >= 2) {
      targetDepth = 3;
    } else {
      targetDepth = this.defaultDepth;
    }

    targetDepth = Math.min(targetDepth, networkMax);

    if (targetDepth === 1) {
      return { depth: 1, continuations: [], reasoning: "Auto: insufficient content for thread" };
    }

    const reasoning = `Auto: ${factsCount} facts, pillar="${pillar}", depth=${targetDepth}`;
    return this.generateContinuations(
      targetDepth,
      rootContent,
      keyFacts,
      topic,
      keywords,
      reasoning,
    );
  }

  /**
   * Generate continuation tweets via a single batched LLM call.
   * Falls back to heuristic splitting when the LLM is unavailable.
   */
  private async generateContinuations(
    depth: number,
    rootContent: string,
    keyFacts: string[],
    topic: string,
    keywords: string[],
    reasoning: string,
  ): Promise<ThreadPlan> {
    const continuationCount = depth - 1;

    if (!this.llm) {
      return {
        depth,
        continuations: this.heuristicContinuations(rootContent, continuationCount, keyFacts),
        reasoning: `${reasoning} (heuristic fallback — no LLM)`,
      };
    }

    try {
      const systemPrompt = `You are a social media thread writer for the brand.
Brand voice: approachable, human, on-brand. No fear-mongering, no medical/financial advice.

Write ${continuationCount} continuation tweet(s) for a thread. The root tweet is provided.
Each continuation must:
  - Add NEW information (don't repeat the root)
  - Be under 280 characters
  - Flow naturally from the previous tweet
  - The LAST tweet should end with a soft CTA or reflective question

Return ONLY the tweets, one per line, numbered 1-${continuationCount}.`;

      const userPrompt = `Topic: ${topic}
Keywords: ${keywords.join(", ")}
Key facts to distribute across continuations:
${keyFacts.map((f, i) => `  ${i + 1}. ${f}`).join("\n")}

Root tweet (position 0):
"${rootContent}"

Write ${continuationCount} continuation tweet(s):`;

      const response = await this.llm.generateChat(systemPrompt, userPrompt, {
        temperature: 0.7,
      });

      const tweets = response.content
        .split("\n")
        .map((line) => line.replace(/^\d+[\.\)]\s*/, "").trim())
        .filter((line) => line.length > 0)
        .slice(0, continuationCount);

      while (tweets.length < continuationCount) {
        const idx = tweets.length;
        tweets.push(keyFacts[idx] ?? `Discover more about ${topic} \u2728`);
      }

      const continuations: ThreadContinuationTweet[] = tweets.map((content, i) => ({
        position: i + 1,
        content: truncateForThread(content),
      }));

      return { depth, continuations, reasoning };
    } catch (err) {
      this.logger.debug(
        `P4: LLM thread generation failed: ${(err as Error).message} — using heuristic`,
      );
      return {
        depth,
        continuations: this.heuristicContinuations(rootContent, continuationCount, keyFacts),
        reasoning: `${reasoning} (heuristic fallback — LLM failed)`,
      };
    }
  }

  /**
   * Heuristic fallback — splits key facts into continuation tweets.
   * Used when the LLM is unavailable or fails.
   */
  private heuristicContinuations(
    rootContent: string,
    count: number,
    keyFacts: string[],
  ): ThreadContinuationTweet[] {
    const continuations: ThreadContinuationTweet[] = [];
    for (let i = 0; i < count; i++) {
      const fact = keyFacts[i];
      const content = fact ? fact : "Discover how this applies to your brand \u2728";
      continuations.push({ position: i + 1, content: truncateForThread(content) });
    }
    return continuations;
  }
}
