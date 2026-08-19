import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { access, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type {
  DomainConfig,
  ContentPillarConfig,
  ContentStyleConfig,
  HumorMechanicConfig,
  SlopLexiconEntryConfig,
  TrendingNicheConfig,
  TrendingEventConfig,
  TrendingKeywordOverrideConfig,
  VisualStyleConfig,
} from './domain-config.types.js';

/**
 * DomainConfigService — loads the user-defined brand/domain context.
 *
 * Uses env vars for simple values and optional JSON/Markdown files for rich
 * lists (prompts, pillars, styles, lexicon, trending). Everything has a safe
 * generic default so the app boots without a custom config.
 */
@Injectable()
export class DomainConfigService implements OnModuleInit {
  private readonly logger = new Logger(DomainConfigService.name);
  private brandVoice: string | null = null;
  private promptCache = new Map<string, string>();

  constructor(private readonly configService: ConfigService) {}

  onModuleInit(): void {
    // Resolve domain context early so typos in env are caught on boot.
    this.logger.log(`Domain context: ${this.brandName} — ${this.domainDescription}`);
  }

  // ── Simple env-based getters ─────────────────────────────────────────────

  get brandName(): string {
    return this.configService.get<string>('BRAND_NAME', 'Social Poster Agent');
  }

  get brandDescription(): string {
    return this.configService.get<string>(
      'BRAND_DESCRIPTION',
      'an AI-assisted multi-network social posting system',
    );
  }

  get domain(): string {
    return this.configService.get<string>('DOMAIN', 'your product or topic area');
  }

  get domainDescription(): string {
    return this.configService.get<string>('BRAND_DESCRIPTION', this.brandDescription);
  }

  get brandVoicePath(): string {
    return this.configService.get<string>('BRAND_VOICE_PATH', '../brand-voice.md');
  }

  get promptDir(): string {
    return this.configService.get<string>('DOMAIN_PROMPT_DIR', 'config/prompts');
  }

  get blogBaseUrl(): string {
    return this.configService.get<string>('BLOG_BASE_URL', '');
  }

  // ── Brand voice ──────────────────────────────────────────────────────────

  async getBrandVoice(): Promise<string> {
    if (this.brandVoice) return this.brandVoice;
    const resolved = this.resolvePath(this.brandVoicePath);
    try {
      await access(resolved);
      this.brandVoice = await readFile(resolved, 'utf-8');
    } catch {
      this.logger.warn(`brand-voice file not found at ${resolved} — using generic guidelines`);
      this.brandVoice = `Be specific, opinionated, and human. No fear-mongering, no absolute predictions, no medical/financial advice, no engagement bait. No hashtags or URLs in posts.`;
    }
    return this.brandVoice;
  }

  // ── Prompt templates ─────────────────────────────────────────────────────

  async getPromptTemplate(name: string): Promise<string | null> {
    const cached = this.promptCache.get(name);
    if (cached) return cached;

    const resolved = this.resolvePath(join(this.promptDir, `${name}.md`));
    try {
      await access(resolved);
      const content = await readFile(resolved, 'utf-8');
      this.promptCache.set(name, content);
      return content;
    } catch {
      return null;
    }
  }

  async getChatPromptTemplate(name: string): Promise<{ systemPrompt: string; userPrompt: string } | null> {
    const raw = await this.getPromptTemplate(name);
    if (!raw) return null;
    const parts = raw.split(/^---\s*$/m);
    if (parts.length >= 2) {
      return {
        systemPrompt: parts[0]!.trim(),
        userPrompt: parts.slice(1).join('\n---\n').trim(),
      };
    }
    return { systemPrompt: raw.trim(), userPrompt: '' };
  }

  // ── Structured JSON configs (optional overrides) ─────────────────────────

  async getContentPillars(): Promise<ContentPillarConfig[]> {
    const path = this.configService.get<string>('CONTENT_PILLARS_PATH', '');
    const fromFile = await this.readJson<ContentPillarConfig[]>(path);
    if (fromFile) return fromFile;
    return [
      { id: 'general', name: 'General', targetRatio: 1, description: 'Default topic bucket' },
    ];
  }

  async getContentStyles(): Promise<ContentStyleConfig[]> {
    const path = this.configService.get<string>('CONTENT_STYLES_PATH', '');
    const fromFile = await this.readJson<ContentStyleConfig[]>(path);
    if (fromFile) return fromFile;
    return [];
  }

  async getHumorMechanics(): Promise<HumorMechanicConfig[]> {
    const path = this.configService.get<string>('HUMOR_MECHANICS_PATH', '');
    const fromFile = await this.readJson<HumorMechanicConfig[]>(path);
    if (fromFile) return fromFile;
    return [];
  }

  async getSlopLexicon(): Promise<Record<string, SlopLexiconEntryConfig>> {
    const path = this.configService.get<string>('SLOP_LEXICON_PATH', '');
    const fromFile = await this.readJson<Record<string, SlopLexiconEntryConfig>>(path);
    if (fromFile) return fromFile;
    return {};
  }

  async getTrendingNiches(): Promise<TrendingNicheConfig[]> {
    const path = this.configService.get<string>('TRENDING_NICHES_PATH', '');
    const fromFile = await this.readJson<TrendingNicheConfig[]>(path);
    if (fromFile) return fromFile;
    return [];
  }

  async getTrendingEvents(): Promise<TrendingEventConfig[]> {
    const path = this.configService.get<string>('TRENDING_EVENTS_PATH', '');
    const fromFile = await this.readJson<TrendingEventConfig[]>(path);
    if (fromFile) return fromFile;
    return [];
  }

  async getTrendingKeywordOverrides(): Promise<TrendingKeywordOverrideConfig[]> {
    const path = this.configService.get<string>('TRENDING_KEYWORD_OVERRIDES_PATH', '');
    const fromFile = await this.readJson<TrendingKeywordOverrideConfig[]>(path);
    if (fromFile) return fromFile;
    return [];
  }

  async getVisualStyles(): Promise<VisualStyleConfig[]> {
    const path = this.configService.get<string>('VISUAL_STYLES_PATH', '');
    const fromFile = await this.readJson<VisualStyleConfig[]>(path);
    if (fromFile) return fromFile;
    return [
      { id: 'quote_card', name: 'Quote card', description: 'Typography-focused card with the post hook' },
      { id: 'aesthetic_photo', name: 'Aesthetic photo', description: 'Mood image that complements the post without text' },
    ];
  }

  getTopicCategories(): string[] {
    const raw = this.configService.get<string>('TOPIC_CATEGORIES', '');
    if (raw) return raw.split(',').map((s) => s.trim()).filter(Boolean);
    return ['general', 'educational', 'trending', 'product', 'opinion', 'behind-the-scenes'];
  }

  /**
   * Build a fully resolved DomainConfig snapshot for consumers that need it.
   */
  async getConfig(): Promise<DomainConfig> {
    return {
      brandName: this.brandName,
      brandDescription: this.brandDescription,
      domain: this.domain,
      domainDescription: this.domainDescription,
      brandVoicePath: this.brandVoicePath,
      promptDir: this.promptDir,
      blogBaseUrl: this.blogBaseUrl,
      topicCategories: this.getTopicCategories(),
      contentPillars: await this.getContentPillars(),
      contentStyles: await this.getContentStyles(),
      humorMechanics: await this.getHumorMechanics(),
      slopLexicon: await this.getSlopLexicon(),
      trendingNiches: await this.getTrendingNiches(),
      trendingEvents: await this.getTrendingEvents(),
      trendingKeywordOverrides: await this.getTrendingKeywordOverrides(),
      visualStyles: await this.getVisualStyles(),
    };
  }

  // ── Helpers ──────────────────────────────────────────────────────────────

  private resolvePath(input: string): string {
    if (input.startsWith('/')) return input;
    return join(process.cwd(), input);
  }

  private async readJson<T>(filePath: string): Promise<T | null> {
    if (!filePath) return null;
    const resolved = this.resolvePath(filePath);
    try {
      await access(resolved);
      const raw = await readFile(resolved, 'utf-8');
      return JSON.parse(raw) as T;
    } catch (err) {
      this.logger.debug(`Could not load ${resolved}: ${(err as Error).message}`);
      return null;
    }
  }
}
