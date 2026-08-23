import { Inject, Injectable } from "@nestjs/common";
import { ILlmPort } from "../../domain/ports/llm.port.js";
import type { ILlmPort as LlmPort } from "../../domain/ports/llm.port.js";
import type { Prisma } from "../../generated/prisma/client.js";
import type { GeneratedPost } from "./generation.graph.js";
import type { PostFactoryInput } from "./generation-persistence.types.js";

@Injectable()
export class PostFactory {
  constructor(@Inject(ILlmPort) private readonly llm: LlmPort) {}

  buildLlmMetadata(
    genPost: GeneratedPost,
    postSimhash: string,
    promptLabels: Record<string, { label: string; isFallback?: boolean }>,
    overrides: Record<string, unknown> = {},
  ): Record<string, unknown> {
    return {
      model: genPost.model,
      tokens: genPost.tokens ?? 0,
      cost: genPost.cost ?? 0,
      promptVersion: this.llm.getPromptVersion?.() ?? "unknown",
      promptLabels,
      hook: genPost.hook,
      hookTechnique: genPost.hookTechnique,
      contentStyleId: genPost.contentStyleId,
      humorMechanicId: genPost.humorMechanicId ?? null,
      angleType: genPost.angle.split("—")[0]?.trim(),
      simhash: postSimhash,
      qualityScore: genPost.qualityScore,
      judgeScores: genPost.judgeScores ?? null,
      visualConcept: genPost.visualConcept ?? null,
      abVariants: genPost.abVariants ?? null,
      authorContext: {
        accountId: genPost.accountId ?? null,
        personaRevisionId: genPost.personaRevisionId ?? null,
        voiceMode: genPost.voiceMode ?? null,
        experimentAssignmentId: genPost.experimentAssignmentId ?? null,
        source: genPost.authorContextSource ?? "GLOBAL_FALLBACK",
      },
      ...overrides,
    };
  }

  build(input: PostFactoryInput): Prisma.PostUncheckedCreateInput {
    const { genPost, accountId, candidateHash, runId, sourceRef, options } = input;
    return {
      accountId,
      network: genPost.network,
      language: options.language ?? "en",
      content: genPost.content,
      generationRunId: runId,
      simhash: candidateHash,
      sourceRef: sourceRef as unknown as Prisma.InputJsonValue,
      canonicalUrl: options.canonicalUrl ?? null,
      personaRevisionId: genPost.personaRevisionId ?? null,
      voiceMode: genPost.voiceMode ?? null,
      experimentAssignmentId: genPost.experimentAssignmentId ?? null,
      llmMetadata: this.buildLlmMetadata(
        genPost,
        candidateHash,
        genPost.promptLabels ?? options.promptLabels ?? {},
        options.editorialAssignmentIds?.[genPost.network]
          ? { editorialAssignmentId: options.editorialAssignmentIds[genPost.network] }
          : undefined,
      ) as Prisma.InputJsonValue,
    };
  }
}
