import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SchedulerRegistry } from '@nestjs/schedule';
import { CronJob } from 'cron';
import { PrismaService } from '../prisma/prisma.service';
import { LlmService } from '../llm/llm.service';
import { parseBool } from '../config/parse-bool';
import { skipIfOrchestrator } from '../../modules/orchestrator/feature-flag.js';

interface LlmTopic {
  topic: string;
  keywords: string[];
  facts: string[];
  category: string;
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
    private readonly llmService: LlmService,
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
    if (skipIfOrchestrator()) return; // Orchestrator handles this
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
    const systemPrompt = `You're a content strategist who actually knows astrology — not the "what's your sign" small-talk kind, but the "I can tell you what degree Saturn was at when you were born" kind. You're brainstorming social media post topics for an astrology brand.

Each topic needs:
- topic: A SPECIFIC, scroll-stopping topic title. Not "Mercury Retrograde" but "Mercury Retrograde in Leo: Why You're Suddenly Re-Texting Your Ex." Not "Moon Signs" but "Your Moon Sign Explains Why You Cry at Commercials." Be specific, be provocative, be human.
- keywords: 3-5 relevant tags
- facts: 2-3 REAL astrological/astronomical facts (no made-up data — real orbital periods, real dates, real traditions)
- category: One of: "zodiac-signs", "planetary", "lunar", "retrograde", "relationships", "career", "wellness", "spiritual", "trending"

TOPIC RULES:
- Be SPECIFIC. "Aries horoscope" is not a topic, it's a category. "Why Aries Always Apologize With Actions Not Words" is a topic.
- Be TIMELY. Reference current or upcoming transits when possible (check what's happening astrologically right now).
- Mix ANGLES: some educational, some entertaining, some provocative, some relatable.
- Don't repeat yourself. If you already have "Mercury retrograde communication," don't also generate "Mercury retrograde texts."
- Think like a CONTENT CREATOR, not an encyclopedia. What would make someone stop scrolling?
- It's okay to be funny, weird, or slightly unhinged. Boring topics = boring posts.

Return a JSON array:
[{"topic": "...", "keywords": ["...", "..."], "facts": ["...", "..."], "category": "..."}]`;

    const userPrompt = `Generate ${count} diverse astrology/wellness topics for social media posts.
Mix categories. Be specific, provocative, and fun. Think "what would I actually stop scrolling to read?"

Return ONLY the JSON array, no markdown, no explanation.`;

    try {
      const response = await this.llmService.generateChat(systemPrompt, userPrompt, {
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
        // not clean JSON, continue to next strategy
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

      // Fetch existing topic strings for dedup
      const existing = await this.prisma.topic.findMany({
        select: { topic: true },
        where: {},
      });
      const existingSet = new Set(existing.map((t) => t.topic.toLowerCase()));

      let inserted = 0;
      for (const t of topics) {
        if (!t.topic || typeof t.topic !== 'string') continue;
        if (existingSet.has(t.topic.toLowerCase())) {
          this.logger.debug(`Skipping duplicate topic: ${t.topic}`);
          continue;
        }

        await this.prisma.topic.create({
          data: {
            topic: t.topic,
            keywords: Array.isArray(t.keywords) ? t.keywords.slice(0, 5) : [],
            facts: Array.isArray(t.facts) ? t.facts.slice(0, 3) : [],
            category: t.category || 'general',
            sourceType: 'llm',
            status: 'active',
          },
        });
        existingSet.add(t.topic.toLowerCase());
        inserted++;
      }

      this.logger.log(`Generated ${inserted} new topics (requested ${count}, parsed ${topics.length})`);
      return inserted;
    } catch (err) {
      this.logger.warn(`Topic generation failed: ${(err as Error).message}`);
      return 0;
    }
  }
}
