import { Injectable, Logger, Inject, Optional, type OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SchedulerRegistry } from '@nestjs/schedule';
import { CronJob } from 'cron';
import { PrismaService } from '../prisma/prisma.service';
import { ILlmPort } from '../../domain/ports/llm.port.js';
import { IPromptPort, type CompiledChatPrompt } from '../../domain/ports/prompt.port.js';
import { parseBool } from '../config/parse-bool';
import { isOrchestratorEnabled } from '../../domain/feature-flags.js';
import { interpolate } from '../../domain/prompt-interpolation.js';
import { TOPIC_GENERATION_PROMPT } from './prompts/topic-generation-prompt.js';

interface LlmTopic {
  topic: string;
  keywords: string[];
  facts: string[];
  category: string;
}

function extractTopLevelJsonArray(text: string): string | null {
  const start = text.indexOf('[');
  if (start === -1) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === '\\') {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
    } else if (ch === '[') {
      depth++;
    } else if (ch === ']') {
      depth--;
      if (depth === 0) {
        return text.slice(start, i + 1);
      }
    }
  }
  return null;
}

/**
 * TopicGenerationService — generates content topics via LLM and stores them in the Topic table.
 *
 * Runs on a cron schedule (default: every 6 hours) and generates a batch of fresh
 * astrology/wellness topics. This replaces the dependency on content-agent-platform
 * (CAP) — topics are now LLM-generated and DB-backed, fully self-contained.
 *
 * When the active topic pool drops below a threshold (default: 20), the cron
 * generates a new batch (default: 15 topics) to keep the pipeline fed.
 *
 * Env:
 *   TOPIC_GENERATION_ENABLED=true/false  (default: true)
 *   TOPIC_GENERATION_CRON=0 STAR/2 * * *  (every 2 hours)
 *   TOPIC_POOL_MIN=30                    (generate when active count < this)
 *   TOPIC_BATCH_SIZE=20                  (how many topics to generate per batch)
 */
@Injectable()
export class TopicGenerationService implements OnModuleInit {
  private readonly logger = new Logger(TopicGenerationService.name);
  private readonly enabled: boolean;
  private readonly cronSchedule: string;
  private readonly poolMin: number;
  private readonly batchSize: number;

  constructor(
    private readonly prisma: PrismaService,
    private readonly configService: ConfigService,
    private readonly schedulerRegistry: SchedulerRegistry,
    @Inject(ILlmPort) private readonly llmService: ILlmPort,
    @Optional() @Inject(IPromptPort) private readonly promptPort?: IPromptPort,
  ) {
    this.enabled = parseBool(this.configService.get<string>('TOPIC_GENERATION_ENABLED', 'true'));
    this.cronSchedule = this.configService.get<string>('TOPIC_GENERATION_CRON', '0 */2 * * *');
    this.poolMin = Number(this.configService.get<string>('TOPIC_POOL_MIN', '30')) || 30;
    this.batchSize = Number(this.configService.get<string>('TOPIC_BATCH_SIZE', '20')) || 20;
  }

  onModuleInit(): void {
    if (!this.enabled) {
      this.logger.log('Topic generation disabled (TOPIC_GENERATION_ENABLED=false)');
      return;
    }

    // Orchestrator mode: GENERATE_TOPICS is handled by the orchestrator decision loop.
    // Still do initial pool warm-up so the first cycle has data.
    if (isOrchestratorEnabled()) {
      this.logger.log('Orchestrator is enabled — topic generation cron NOT registered (initial warm-up still runs)');
      this.generateIfNeeded().catch((err) => {
        this.logger.warn(`Startup topic generation failed: ${(err as Error).message}`);
      });
      return;
    }

    // Generate immediately on startup if pool is empty (first boot / cold start)
    this.generateIfNeeded().catch((err) => {
      this.logger.warn(`Startup topic generation failed: ${(err as Error).message}`);
    });

    const job = new CronJob(this.cronSchedule, async () => {
      await this.generateIfNeeded();
    });

    try {
      this.schedulerRegistry.addCronJob('topic-generation', job);
      job.start();
      this.logger.log(`Topic generation cron registered: ${this.cronSchedule}`);
    } catch {
      this.logger.warn('SchedulerRegistry not available — topic generation cron will not run');
    }
  }

  /**
   * Check active topic pool and generate if below threshold.
   */
  async generateIfNeeded(): Promise<void> {
    const activeCount = await this.prisma.topic.count({ where: { status: 'active' } });
    this.logger.log(`Topic pool: ${activeCount} active (threshold: ${this.poolMin})`);

    if (activeCount >= this.poolMin) {
      this.logger.debug('Topic pool sufficient — skipping generation');
      return;
    }

    const toGenerate = this.batchSize;
    this.logger.log(`Generating ${toGenerate} new topics via LLM...`);
    await this.generateBatch(toGenerate);
  }

  /**
   * Generate a batch of topics via LLM and store in DB.
   * Deduplicates against existing topics (by exact topic string).
   */
  async generateBatch(count: number): Promise<number> {
    const compiled = await this.getCompiledChat(
      'topic-generation',
      { count: String(count) },
      TOPIC_GENERATION_PROMPT,
    );

    try {
      const response = await this.llmService.generateChat(compiled.systemPrompt, compiled.userPrompt, {
        temperature: 0.8,
        maxTokens: 4000,
      });

      // Log raw response for debugging if it's short enough
      const raw = response.content.trim();
      this.logger.debug(`Topic generation LLM response (${raw.length} chars): ${raw.slice(0, 200)}...`);

      // Strip markdown code blocks if present
      let cleaned = raw;
      if (cleaned.startsWith('```')) {
        cleaned = cleaned.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '');
      }

      // Parse JSON array from response — try multiple strategies
      let topics: LlmTopic[] | null = null;

      // Strategy 1: direct parse (clean JSON)
      try {
        topics = JSON.parse(cleaned);
      } catch {
        const arrayJson = extractTopLevelJsonArray(cleaned);
        if (arrayJson) {
          try {
            topics = JSON.parse(arrayJson);
          } catch {
            // not clean JSON, continue to next strategy
          }
        }
      }

      // Strategy 2: extract first [ to last ] (regex)
      if (!topics) {
        const jsonMatch = cleaned.match(/\[[\s\S]*\]/);
        if (jsonMatch) {
          try {
            topics = JSON.parse(jsonMatch[0]);
          } catch {
            // regex match failed too, continue
          }
        }
      }

      // Strategy 3: if JSON is truncated (no closing ]), try to repair it
      if (!topics) {
        const startIdx = cleaned.indexOf('[');
        if (startIdx !== -1) {
          let partial = cleaned.slice(startIdx);
          // If no closing bracket, try to close the last object and array
          if (!partial.includes(']')) {
            // Find last complete object (ends with })
            const lastObj = partial.lastIndexOf('}');
            if (lastObj !== -1) {
              partial = partial.slice(0, lastObj + 1) + ']';
              try {
                topics = JSON.parse(partial);
              } catch {
                // repair failed
              }
            }
          }
        }
      }

      if (!topics) {
        this.logger.warn(`Topic generation: JSON parse failed. Raw response (first 300 chars): ${raw.slice(0, 300)}`);
        return 0;
      }

      if (!Array.isArray(topics) || topics.length === 0) {
        this.logger.warn('Topic generation: empty or invalid array');
        return 0;
      }

      // Build valid, batch-deduped topic rows. DB-level uniqueness (Topic.topic @unique)
      // plus createMany skipDuplicates handles race conditions and existing topics.
      const seen = new Set<string>();
      const data = topics
        .filter((t) => t.topic && typeof t.topic === 'string')
        .map((t) => {
          const topic = t.topic.trim();
          return {
            topic,
            keywords: Array.isArray(t.keywords) ? t.keywords.slice(0, 5) : [],
            facts: Array.isArray(t.facts) ? t.facts.slice(0, 3) : [],
            category: t.category || 'general',
            sourceType: 'llm' as const,
            status: 'active' as const,
          };
        })
        .filter((row) => {
          const key = row.topic.toLowerCase();
          if (seen.has(key)) return false;
          seen.add(key);
          return true;
        });

      if (data.length === 0) {
        this.logger.log(`Generated 0 new topics (requested ${count}, parsed ${topics.length})`);
        return 0;
      }

      const result = await this.prisma.topic.createMany({
        data,
        skipDuplicates: true,
      });

      this.logger.log(`Generated ${result.count} new topics (requested ${count}, parsed ${topics.length})`);
      return result.count;
    } catch (err) {
      this.logger.warn(`Topic generation failed: ${(err as Error).message}`);
      return 0;
    }
  }

  /**
   * Fetch the prompt from Langfuse Prompt Management when available,
   * otherwise interpolate the local fallback.
   */
  private async getCompiledChat(
    name: string,
    variables: Record<string, string>,
    fallback: CompiledChatPrompt,
  ): Promise<CompiledChatPrompt> {
    if (this.promptPort) {
      return this.promptPort.getCompiledChat(name, variables, fallback);
    }
    return {
      systemPrompt: interpolate(fallback.systemPrompt, variables),
      userPrompt: interpolate(fallback.userPrompt, variables),
      isFallback: true,
    };
  }
}
