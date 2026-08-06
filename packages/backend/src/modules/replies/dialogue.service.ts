/**
 * DialogueService — builds a conversation from the DB and runs the DialogueGraph.
 *
 * Responsibilities:
 *   - Load all comments in a conversation thread up to the target comment
 *   - Build a linear message history (user + assistant turns)
 *   - Detect language of the latest comment
 *   - Invoke the DialogueGraph to decide whether to reply
 *   - Return a DialogueDecision the RepliesMonitor can execute
 */
import { Injectable, Logger, Inject, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../infrastructure/prisma/prisma.service.js';
import { ILlmPort } from '../../domain/ports/llm.port.js';
import { IPromptPort } from '../../domain/ports/prompt.port.js';
import { detectLanguage } from '../../infrastructure/util/language-detector.js';
import type { IncomingComment, SocialNetwork } from '@prisma/client';
import { QuestionClassifierService } from './question-classifier.service.js';
import { ToneAnalyzerService } from './tone-analyzer.service.js';
import {
  compileDialogueGraph,
  createDialogueState,
  type DialogueMessage,
  type DialogueDecision,
  type DialogueStateType,
} from './dialogue.graph.js';

export type { DialogueDecision };

type CompiledGraph = ReturnType<typeof compileDialogueGraph>;

@Injectable()
export class DialogueService {
  private readonly logger = new Logger(DialogueService.name);
  private readonly maxDepth: number;
  private readonly autoReplyComplexity: 'low' | 'medium' | 'high';
  private readonly repliesTemperature: number;
  private compiledGraph: CompiledGraph | null = null;

  constructor(
    @Inject(ILlmPort) private readonly llm: ILlmPort,
    private readonly questionClassifier: QuestionClassifierService,
    private readonly toneAnalyzer: ToneAnalyzerService,
    private readonly prisma: PrismaService,
    private readonly configService: ConfigService,
    @Optional() @Inject(IPromptPort) private readonly promptPort?: IPromptPort,
  ) {
    const rawDepth = Number(this.configService.get<string>('REPLIES_MAX_CONVERSATION_DEPTH', '3'));
    this.maxDepth = Number.isFinite(rawDepth) && rawDepth > 0 ? rawDepth : 3;

    const complexity = this.configService.get<string>('REPLIES_AUTO_REPLY_COMPLEXITY', 'medium');
    this.autoReplyComplexity = complexity === 'low' || complexity === 'medium' || complexity === 'high'
      ? complexity
      : 'medium';

    const rawTemp = Number(this.configService.get<string>('REPLIES_TEMPERATURE', '0.6'));
    this.repliesTemperature = Number.isFinite(rawTemp) && rawTemp >= 0 && rawTemp <= 2 ? rawTemp : 0.6;
  }

  private getGraph(): CompiledGraph {
    if (!this.compiledGraph) {
      this.compiledGraph = compileDialogueGraph(
        {
          llm: this.llm,
          questionClassifier: this.questionClassifier,
          toneAnalyzer: this.toneAnalyzer,
          promptPort: this.promptPort,
          repliesTemperature: this.repliesTemperature,
        },
        // No checkpointer by default — conversation state is rebuilt from the DB
        // on each monitoring cycle. This keeps the DB as the single source of truth.
      );
    }
    return this.compiledGraph;
  }

  /**
   * Process one incoming comment in the context of its conversation thread.
   */
  async processComment(
    comment: IncomingComment,
    postContent: string,
  ): Promise<DialogueDecision> {
    const conversationId = comment.conversationId ?? comment.commentId;
    const detectedLanguage = detectLanguage(comment.text);
    const messages = await this.buildMessages(comment, conversationId);

    const state = createDialogueState({
      conversationId,
      postId: comment.postId,
      commentDbId: comment.id,
      network: comment.network,
      postContent,
      detectedLanguage,
      maxDepth: this.maxDepth,
      autoReplyComplexity: this.autoReplyComplexity,
      messages,
    });

    const startTime = Date.now();
    try {
      const result = (await this.getGraph().invoke(state, {
        configurable: { thread_id: conversationId },
      })) as DialogueStateType;

      const elapsed = Date.now() - startTime;
      this.logger.debug(
        `DialogueGraph for ${conversationId} completed in ${elapsed}ms: ${result.decision?.action ?? 'no decision'}`,
      );

      // Persist question classification for analytics and UI filtering.
      if (result.classification && comment.id) {
        await this.prisma.incomingComment.update({
          where: { id: comment.id },
          data: {
            isQuestion: result.classification.isQuestion,
            questionConfidence: result.classification.confidence,
            questionType: result.classification.questionType,
          },
        });
      }

      return (
        result.decision ?? {
          action: 'skip' as const,
          reason: 'Graph returned no decision',
        }
      );
    } catch (err) {
      this.logger.error(
        `DialogueGraph failed for ${conversationId}: ${(err as Error).message}`,
      );
      return { action: 'skip', reason: `DialogueGraph error: ${(err as Error).message}` };
    }
  }

  /**
   * Build the message history for the target comment.
   *
   * Loads all comments in the conversation with scrapedAt <= target.scrapedAt,
   * sorted chronologically. Inserts assistant (our) replies after the user
   * comments they respond to, but only if the reply has already been posted.
   */
  private async buildMessages(
    target: IncomingComment,
    conversationId: string,
  ): Promise<DialogueMessage[]> {
    const allComments = await this.prisma.incomingComment.findMany({
      where: {
        conversationId,
        scrapedAt: { lte: target.scrapedAt },
      },
      orderBy: { scrapedAt: 'asc' },
    });

    const messages: DialogueMessage[] = [];
    let targetIncluded = false;
    for (const c of allComments) {
      const userMessage: DialogueMessage = {
        role: 'user',
        author: c.author,
        text: c.text,
        commentId: c.commentId,
        depth: c.depth,
        isQuestion: c.isQuestion,
        questionType: c.questionType,
      };
      messages.push(userMessage);

      // If we already replied to this comment and it was posted before the
      // target was scraped, include our assistant turn in the context.
      if (c.replyText && c.replyPostedAt && c.replyPostedAt <= target.scrapedAt) {
        messages.push({
          role: 'assistant',
          author: '',
          text: c.replyText,
          commentId: c.replyUrl ?? `${c.commentId}-reply`,
          depth: c.depth + 1,
        });
      }

      // Stop once we reach the target — do not include later turns.
      if (c.id === target.id) {
        targetIncluded = true;
        break;
      }
    }

    // Fallback for tests or first scrape: the target itself may not yet be persisted.
    if (!targetIncluded) {
      messages.push({
        role: 'user',
        author: target.author,
        text: target.text,
        commentId: target.commentId,
        depth: target.depth,
        isQuestion: target.isQuestion,
        questionType: target.questionType,
      });
    }

    return messages;
  }
}
