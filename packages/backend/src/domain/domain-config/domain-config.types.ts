/**
 * Domain/brand configuration types.
 *
 * These describe the project-specific context the posting agent uses when
 * generating content, evaluating trends, and engaging. All values have
 * generic defaults; users override via env vars and optional JSON/Markdown
 * config files under `config/`.
 */

export interface ContentPillarConfig {
  id: string;
  name: string;
  targetRatio: number;
  description: string;
}

export interface ContentStyleConfig {
  id: string;
  name: string;
  description: string;
  promptGuidance: string;
  example: string;
  worksForShort: boolean;
  worksForLong: boolean;
  humorCompatible: boolean;
}

export interface HumorMechanicConfig {
  id: string;
  name: string;
  guidance: string;
}

export interface SlopLexiconEntryConfig {
  words: string[];
  phrases: string[];
}

export interface TrendingNicheConfig {
  /** Human-readable niche label. */
  label: string;
  /** Keywords that identify a trend as relevant. */
  keywords: string[];
}

export interface TrendingEventConfig {
  name: string;
  date: string; // ISO date
  windowDays: number;
  topic: string;
  networks: string[];
}

export interface TrendingKeywordOverrideConfig {
  /** Blocklist keyword that can be overridden by context. */
  keyword: string;
  /** Context words that legitimize the keyword for this domain. */
  contexts: string[];
}

export interface VisualStyleConfig {
  id: string;
  name: string;
  description: string;
}

/**
 * Parsed domain config, including all optional overrides.
 */
export interface DomainConfig {
  brandName: string;
  brandDescription: string;
  /** The subject domain (e.g. "sustainable coffee", "dev tools"). */
  domain: string;
  /** Short description used in prompts. */
  domainDescription: string;
  /** Path to the brand voice markdown file. */
  brandVoicePath: string;
  /** Directory for prompt markdown overrides. */
  promptDir: string;
  /** Base URL for canonical blog links. */
  blogBaseUrl: string;
  /** Default topic categories for the topic-generation prompt. */
  topicCategories: string[];
  /** Content pillars for diversity rotation. */
  contentPillars: ContentPillarConfig[];
  /** Content styles for rotation. */
  contentStyles: ContentStyleConfig[];
  /** Humor mechanics for the humor layer. */
  humorMechanics: HumorMechanicConfig[];
  /** Slop lexicon per language. */
  slopLexicon: Record<string, SlopLexiconEntryConfig>;
  /** Trending niches/keywords. */
  trendingNiches: TrendingNicheConfig[];
  /** Calendar of domain-specific recurring events. */
  trendingEvents: TrendingEventConfig[];
  /** Keyword overrides for the trend guardrail. */
  trendingKeywordOverrides: TrendingKeywordOverrideConfig[];
  /** Visual styles for image concept generation. */
  visualStyles: VisualStyleConfig[];
}
