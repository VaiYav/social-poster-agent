import { Injectable, Logger, Optional } from "@nestjs/common";
import type { JudgeScores } from "@spa/shared";
import { PostsService } from "../posts/posts.service.js";
import { ABVariantService } from "../content-enhancements/ab-variant.service.js";
import { OnlineEvaluationService } from "../evaluation/online-evaluation.service.js";
import { getNetworkProfile } from "../../domain/network-profiles/network-profiles.js";
import type { SocialNetwork } from "../../generated/prisma/client.js";
import { isDuplicateHash, simhash } from "./simhash.js";
import type { GeneratedPost } from "./generation.graph.js";
import { PostFactory } from "./post.factory.js";
import type {
  GenerationAccount,
  GenerationPersistenceOptions,
  GenerationSourceRef,
  PersistedGenerationPost,
} from "./generation-persistence.types.js";

export type {
  GenerationAccount,
  GenerationPersistenceOptions,
  GenerationSourceRef,
  PersistedGenerationPost,
} from "./generation-persistence.types.js";

@Injectable()
export class GenerationPersistenceService {
  private readonly logger = new Logger(GenerationPersistenceService.name);
  private readonly accountRotationIndexes = new Map<SocialNetwork, number>();
  private readonly postFactory: PostFactory;

  constructor(
    private readonly postsService: PostsService,
    @Optional() private abVariantService?: ABVariantService,
    @Optional() private onlineEvaluator?: OnlineEvaluationService,
    @Optional() postFactory?: PostFactory,
  ) {
    this.postFactory = postFactory ?? new PostFactory({} as never);
  }

  configureOptionalServices(
    abVariantService?: ABVariantService,
    onlineEvaluator?: OnlineEvaluationService,
  ): void {
    this.abVariantService = abVariantService;
    this.onlineEvaluator = onlineEvaluator;
  }

  buildPostLlmMetadata(
    genPost: GeneratedPost,
    postSimhash: string,
    promptLabels: Record<string, { label: string; isFallback?: boolean }>,
    overrides: Record<string, unknown> = {},
  ): Record<string, unknown> {
    return this.postFactory.buildLlmMetadata(genPost, postSimhash, promptLabels, overrides);
  }

  async persistGeneratedPosts(
    generatedPosts: GeneratedPost[],
    accountsByNetwork: Map<
      SocialNetwork,
      Array<GenerationAccount | null> | GenerationAccount | null | undefined
    >,
    runId: string,
    sourceRef: GenerationSourceRef,
    options: GenerationPersistenceOptions = {},
  ): Promise<PersistedGenerationPost[]> {
    const savedPosts: PersistedGenerationPost[] = [];
    const recentHashes = options.recentHashes ?? [];

    for (const genPost of generatedPosts) {
      if (!genPost.content) {
        this.logger.warn(`Generated post empty for ${genPost.network} / "${sourceRef.topic}"`);
        continue;
      }
      const candidateHash = simhash(genPost.content);
      if (isDuplicateHash(candidateHash, recentHashes)) {
        this.logger.warn(
          `Skipping near-duplicate post for ${genPost.network} / "${sourceRef.topic}" — SimHash match`,
        );
        continue;
      }
      const configured = accountsByNetwork.get(genPost.network);
      const accounts = (Array.isArray(configured) ? configured : [configured]).filter(
        (account): account is GenerationAccount => Boolean(account),
      );
      const rotated = this.nextGenerationAccount(genPost.network, accounts);
      const generatedAccount = genPost.accountId
        ? accounts.find((account) => account.id === genPost.accountId)
        : undefined;
      const account = generatedAccount ?? rotated;
      if (!account) continue;

      const post = await this.postsService.create(
        this.postFactory.build({
          genPost,
          accountId: account.id,
          candidateHash,
          runId,
          sourceRef,
          options,
        }),
      );
      await this.evaluateOnlineOutput(post.id, genPost);
      await this.persistPostVariants(post.id, genPost, genPost.judgeScores);
      savedPosts.push({ ...post, accountId: account.id });
      recentHashes.push(candidateHash);
      this.logger.debug(
        `Created draft post for ${genPost.network} (score: ${genPost.qualityScore ?? "n/a"}/10): ${genPost.content.slice(0, 50)}...`,
      );
    }
    return savedPosts;
  }

  async persistPostVariants(
    postId: string,
    genPost: GeneratedPost,
    judgeScores?: JudgeScores,
  ): Promise<void> {
    if (!this.abVariantService) return;
    try {
      await this.abVariantService.createVariants(
        postId,
        genPost.network,
        genPost.content,
        genPost.abVariants ?? null,
        judgeScores,
      );
    } catch (error) {
      this.logger.warn(`Failed to persist A/B variants for ${postId}: ${errorMessage(error)}`);
    }
  }

  async persistPostVariantForContent(
    postId: string,
    network: SocialNetwork,
    content: string,
    judgeScores?: JudgeScores,
  ): Promise<void> {
    if (!this.abVariantService) return;
    try {
      await this.abVariantService.createVariants(postId, network, content, null, judgeScores);
    } catch (error) {
      this.logger.warn(`Failed to persist default variant for ${postId}: ${errorMessage(error)}`);
    }
  }

  async evaluateOnlineOutput(postId: string, generated: GeneratedPost): Promise<void> {
    if (!this.onlineEvaluator) return;
    const promptLabels = generated.promptLabels ?? {};
    const model = generated.model?.trim();
    const provider = model?.includes("/") ? model.split("/", 1)[0] : undefined;
    await this.onlineEvaluator
      .evaluate({
        postId,
        content: generated.content,
        network: generated.network,
        maxCharacters: getNetworkProfile(generated.network).charLimit,
        taskCompleted: true,
        provider,
        model,
        promptManaged: Object.keys(promptLabels).length > 0,
        promptLinked:
          Object.keys(promptLabels).length > 0 &&
          Object.values(promptLabels).every((reference) => Boolean(reference.label)),
        usageKnown: typeof generated.tokens === "number",
        costKnown: typeof generated.cost === "number",
        language: "en",
      })
      .catch((error) => {
        this.logger.warn(`Online evaluator failed for post ${postId}: ${errorMessage(error)}`);
      });
  }

  private nextGenerationAccount(
    network: SocialNetwork,
    accounts: GenerationAccount[],
  ): GenerationAccount | null {
    if (accounts.length === 0) return null;
    const current = this.accountRotationIndexes.get(network) ?? 0;
    const account = accounts[current % accounts.length] ?? accounts[0] ?? null;
    this.accountRotationIndexes.set(network, (current + 1) % accounts.length);
    return account;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
