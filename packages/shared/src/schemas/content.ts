// Content source schemas — shared between backend and UI.
// These describe the artifacts produced by content-agent-platform (CAP)
// and the blog frontmatter format. Moved from infrastructure/content/
// to shared so any adapter can use them without circular deps.

import { z } from 'zod';

// ============================================================
// CAP run artifacts
// ============================================================

export const BriefSchema = z.object({
  topic: z.string(),
  source_locale: z.string().default('en'),
  target_queries: z.array(z.string()).default([]),
  intent: z.string().default('informational'),
  outline: z
    .array(
      z.object({
        heading: z.string(),
        intent_note: z.string().optional(),
        entities: z.array(z.string()).default([]),
      }),
    )
    .default([]),
});
export type Brief = z.infer<typeof BriefSchema>;

export const TopicQueueEntrySchema = z.object({
  topic: z.string().optional(),
  keyword: z.string().optional(),
  cluster_id: z.string().optional(),
  status: z.string().optional(),
  rank: z.number().optional(),
});
export type TopicQueueEntry = z.infer<typeof TopicQueueEntrySchema>;

// topic-queue.json — ranked topic clusters from CAP
export const TopicQueueSchema = z.object({
  locale: z.string().default('en'),
  seeds: z.array(z.string()).default([]),
  clusters: z
    .array(
      z.object({
        representative: z.string(),
        members: z.number().default(1),
        status: z.string().default('new'),
        score: z.number().default(0),
      }),
    )
    .default([]),
});
export type TopicQueue = z.infer<typeof TopicQueueSchema>;

// create-*/report.json — freshly created articles report from CAP
export const CreateRunReportSchema = z.object({
  files: z.array(z.string()).default([]),
  skipped: z.array(z.string()).default([]),
  tokens_in: z.number().default(0),
  tokens_out: z.number().default(0),
  usd: z.number().default(0),
  steps: z.number().default(0),
  errors: z.array(z.string()).default([]),
});
export type CreateRunReport = z.infer<typeof CreateRunReportSchema>;

// ============================================================
// Blog article frontmatter
// ============================================================

export const ArticleFrontmatterSchema = z.object({
  title: z.string(),
  description: z.string().default(''),
  date: z.string().optional(),
  category: z.string().optional(),
  // F10: tags may be written as a comma-separated YAML string (common in Jekyll/Hugo).
  tags: z
    .preprocess(
      (val) => {
        if (Array.isArray(val)) return val;
        if (typeof val === 'string') return val.split(',').map((s) => s.trim()).filter(Boolean);
        return [];
      },
      z.array(z.string()).default([]),
    ),
  // F10: answerCapsule may be a plain string (legacy CAP output) or the full object.
  answerCapsule: z
    .preprocess(
      (val) => {
        if (typeof val === 'string') return { answer: val };
        return val;
      },
      z
        .object({
          question: z.string().optional(),
          answer: z.string().optional(),
          // F10: keyPoints may also be a comma/semicolon-separated string.
          keyPoints: z
            .preprocess(
              (val) => {
                if (Array.isArray(val)) return val;
                if (typeof val === 'string') return val.split(/[,;]/).map((s) => s.trim()).filter(Boolean);
                return [];
              },
              z.array(z.string()).default([]),
            ),
        })
        .optional()
        .nullable(),
    )
    .optional()
    .nullable(),
  seo: z
    .object({
      title: z.string().optional(),
      description: z.string().optional(),
      keywords: z
        .union([z.array(z.string()), z.string().transform((s) => s.split(',').map((k) => k.trim()).filter(Boolean))])
        .default([]),
    })
    .optional(),
});
export type ArticleFrontmatter = z.infer<typeof ArticleFrontmatterSchema>;

// ============================================================
// Content topic — unified type for all sources
// ============================================================

export const ContentTopicSchema = z.object({
  sourceType: z.enum(['brief', 'article', 'topic', 'create_run']),
  path: z.string(),
  topic: z.string(),
  keywords: z.array(z.string()).default([]),
  facts: z.array(z.string()).default([]),
  outline: z
    .array(
      z.object({
        heading: z.string(),
        entities: z.array(z.string()).default([]),
      }),
    )
    .optional(),
  // B5: category diversity + freshness priority
  category: z.string().optional(),
  publishedAt: z.coerce.date().optional(),
  // Language code (ISO 639-1): en, ru, uk, es, it — used for multilingual generation
  language: z.string().default('en'),
  // P2-04: social promo trigger — track the original published post this topic was derived from
  originalPostId: z.string().optional(),
  originalTopic: z.string().optional(),
  canonicalUrl: z.string().url().optional(),
});
export type ContentTopic = z.infer<typeof ContentTopicSchema>;

// ============================================================
// Content source configuration — used by Content Adapters Beyond CAP
// ============================================================

export const ContentSourceConfigSchema = z.object({
  sourceType: z.string().min(1),
  name: z.string().optional(),
  enabled: z.boolean().default(true),
  priority: z.number().optional(),
  config: z.record(z.unknown()).default({}),
});
export type ContentSourceConfig = z.infer<typeof ContentSourceConfigSchema>;

export const ContentSourcesConfigSchema = z.array(ContentSourceConfigSchema);
export type ContentSourcesConfig = z.infer<typeof ContentSourcesConfigSchema>;
