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

// ============================================================
// Blog article frontmatter
// ============================================================

export const ArticleFrontmatterSchema = z.object({
  title: z.string(),
  description: z.string().default(''),
  date: z.string().optional(),
  category: z.string().optional(),
  tags: z.array(z.string()).default([]),
  answerCapsule: z
    .object({
      question: z.string().optional(),
      answer: z.string().optional(),
      keyPoints: z.array(z.string()).default([]),
    })
    .optional(),
  seo: z
    .object({
      title: z.string().optional(),
      description: z.string().optional(),
      keywords: z.array(z.string()).default([]),
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
});
export type ContentTopic = z.infer<typeof ContentTopicSchema>;
