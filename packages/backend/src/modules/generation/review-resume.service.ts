import { Injectable } from "@nestjs/common";
import { Command } from "@langchain/langgraph";
import { SocialNetwork } from "../../generated/prisma/client.js";
import { AccountsService } from "../accounts/accounts.service.js";
import { SseService } from "../../infrastructure/sse/sse.service.js";
import {
  GenerationPersistenceService,
  type GenerationPersistenceOptions,
} from "./generation-persistence.service.js";
import type { GeneratedPost } from "./generation.graph.js";

export interface ReviewGraphConfig {
  configurable: { thread_id: string };
  recursionLimit: number;
  runName: string;
}

export interface ReviewGraphResult {
  readonly finalState: unknown;
  readonly promptLabels: GenerationPersistenceOptions["promptLabels"];
}

export type ReviewGraphInvoker = (
  config: ReviewGraphConfig,
  command: Command,
  context: { runId: string; topic: string; approved: boolean },
) => Promise<ReviewGraphResult>;

export type RecentHashesLoader = (topic: string) => Promise<string[]>;

@Injectable()
export class ReviewResumeService {
  constructor(
    private readonly accountsService: AccountsService,
    private readonly sseService: SseService,
    private readonly persistenceService: GenerationPersistenceService,
  ) {}

  async resume(
    runId: string,
    topic: string,
    approved: boolean,
    edits: Record<string, string> | undefined,
    invokeGraph: ReviewGraphInvoker,
    loadRecentHashes: RecentHashesLoader,
  ): Promise<{ runId: string; topic: string; status: string }> {
    const config: ReviewGraphConfig = {
      configurable: { thread_id: `${runId}:${topic}` },
      recursionLimit: 30,
      runName: "generation.workflow",
    };
    const { finalState, promptLabels } = await invokeGraph(
      config,
      new Command({ resume: { approved, edits } }),
      { runId, topic, approved },
    );
    const generatedPosts = (finalState as { posts?: GeneratedPost[] }).posts ?? [];
    const accountByNetwork = new Map<
      SocialNetwork,
      Awaited<ReturnType<AccountsService["getNextAccountForNetwork"]>>
    >();
    const postNetworks = [...new Set(generatedPosts.map((post) => post.network))];
    await Promise.all(
      postNetworks.map(async (network) => {
        accountByNetwork.set(network, await this.accountsService.getNextAccountForNetwork(network));
      }),
    );

    const recentHashes = await loadRecentHashes(topic);
    const savedPosts = await this.persistenceService.persistGeneratedPosts(
      generatedPosts,
      accountByNetwork,
      runId,
      { type: "review", path: "", topic, keywords: [] },
      { recentHashes, promptLabels },
    );

    await this.sseService.publish({
      type: "generation_completed",
      runId,
      postCount: savedPosts.length,
    });
    return { runId, topic, status: "completed" };
  }
}
