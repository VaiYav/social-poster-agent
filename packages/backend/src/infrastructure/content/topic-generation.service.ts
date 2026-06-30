import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SchedulerRegistry } from '@nestjs/schedule';
import { CronJob } from 'cron';
import { PrismaService } from '../prisma/prisma.service';
import { LlmService } from '../llm/llm.service';
import { parseBool } from '../config/parse-bool';

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
 *   TOPIC_GENERATION_CRON=0 STAR/6 * * *  (every 6 hours)
 *   TOPIC_POOL_MIN=20                    (generate when active count < this)
 *   TOPIC_BATCH_SIZE=15                  (how many topics to generate per batch)
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
    this.cronSchedule = this.configService.get<string>('TOPIC_GENERATION_CRON', '0 */6 * * *');
    this.poolMin = Number(this.configService.get<string>('TOPIC_POOL_MIN', '20')) || 20;
    this.batchSize = Number(this.configService.get<string>('TOPIC_BATCH_SIZE', '15')) || 15;
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
    const systemPrompt = `You are a content strategist for an astrology/wellness social media brand ("My Zodiac AI").
Your task is to generate engaging social media content topics.

Each topic must include:
- topic: A compelling, specific topic title (not generic — e.g., "Mercury Retrograde in Leo: How It Affects Your Communication" not just "Mercury Retrograde")
- keywords: 3-5 relevant keywords/tags for the topic
- facts: 2-3 interesting astrological facts or data points about the topic (real astronomical/astrological data, not made up)
- category: One of: "zodiac-signs", "planetary", "lunar", "retrograde", "relationships", "career", "wellness", "spiritual", "trending"

Topic guidelines:
- Be specific and timely (reference current astrological events when possible)
- Mix educational, entertaining, and inspirational angles
- Avoid repetitive topics — each should be distinct
- Topics should work as social media posts (X, Threads, Facebook)
- Include seasonal/timely angles when relevant

Return your response as a JSON array:
[{"topic": "...", "keywords": ["...", "..."], "facts": ["...", "..."], "category": "..."}]`;

    const userPrompt = `Generate ${count} diverse astrology/wellness topics for social media posts.
Make them varied across categories. Avoid generic topics like just "Aries horoscope" — be specific and engaging.

Return ONLY the JSON array, no markdown or explanation.`;

    try {
      const response = await this.llmService.generateChat(systemPrompt, userPrompt, {
        temperature: 0.8,
        maxTokens: 2000,
      });

      // Parse JSON array from response
      const jsonMatch = response.content.match(/\[[\s\S]*\]/);
      if (!jsonMatch) {
        this.logger.warn('Topic generation: no JSON array found in LLM response');
        return 0;
      }

      let topics: LlmTopic[];
      try {
        topics = JSON.parse(jsonMatch[0]);
      } catch {
        this.logger.warn('Topic generation: JSON parse failed');
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
