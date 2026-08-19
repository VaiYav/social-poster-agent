/**
 * F10: Deep fact extraction from article markdown.
 *
 * Extracts concise, reusable facts from the article body and merges them with
 * frontmatter facts (answerCapsule.keyPoints, answer, description). Designed
 * to feed `ContentReader` → `GenerationService.repurposeFromArticles()`.
 */

export interface ExtractFactsOptions {
  /** Maximum number of facts to return. */
  maxFacts?: number;
  /** Minimum fact length in characters. */
  minLength?: number;
  /** Maximum fact length in characters. */
  maxLength?: number;
  /** Treat H2/H3 headings as facts. */
  includeHeadings?: boolean;
  /** Treat bullet/numbered list items as facts. */
  includeLists?: boolean;
  /** Treat `**bold**` phrases as facts. */
  includeBold?: boolean;
  /** Include the first sentence of each non-list paragraph. */
  includeParagraphs?: boolean;
}

const DEFAULT_OPTIONS: Required<ExtractFactsOptions> = {
  maxFacts: 10,
  minLength: 15,
  maxLength: 240,
  includeHeadings: true,
  includeLists: true,
  includeBold: true,
  includeParagraphs: true,
};

/**
 * Normalize a raw fact string: remove markdown syntax, collapse whitespace,
 * trim, and enforce length bounds. Returns `null` if the result is too short.
 */
export function normalizeFact(raw: string, minLength = 20, maxLength = 240): string | null {
  let s = raw
    .replace(/\r\n/g, '\n')
    .replace(/\s+/g, ' ')
    .replace(/!\[([^\]]*)\]\([^)]+\)/g, '$1') // ![alt](url) -> alt first
    .replace(/(?<!!)\[([^\]]+)\]\([^)]+\)/g, '$1') // [text](url) -> text, not after !
    .replace(/~~([^~]+)~~/g, '$1') // strikethrough
    .replace(/[*_`#]/g, '') // bold/italic/code/heading markers (keep ~ for "approx")
    .replace(/\n+/g, ' ')
    .trim();

  if (s.length < minLength) return null;
  if (s.length > maxLength) {
    // Try to cut at the last sentence boundary before maxLength.
    const truncated = s.slice(0, maxLength + 1);
    const lastBoundary = Math.max(
      truncated.lastIndexOf('. '),
      truncated.lastIndexOf('! '),
      truncated.lastIndexOf('? '),
    );
    if (lastBoundary > minLength) {
      s = s.slice(0, lastBoundary + 1).trim();
    } else {
      s = s.slice(0, maxLength).trim();
    }
  }
  return s || null;
}

/**
 * Collect frontmatter-derived facts: keyPoints, answer, description.
 */
function buildFrontmatterFacts(
  frontmatter: {
    answerCapsule?: { keyPoints?: string[]; answer?: string } | null;
    description?: string;
  } = {},
): string[] {
  const facts: string[] = [];
  if (frontmatter.answerCapsule?.keyPoints) {
    facts.push(...frontmatter.answerCapsule.keyPoints);
  }
  if (frontmatter.answerCapsule?.answer) {
    facts.push(frontmatter.answerCapsule.answer);
  }
  // Only use description as a fallback when there is no structured answerCapsule.
  if (facts.length === 0 && frontmatter.description) {
    facts.push(frontmatter.description);
  }
  return facts.filter((f) => typeof f === 'string' && f.trim().length > 0);
}

/**
 * Extract a list of reusable facts from article markdown.
 *
 * @param markdown - Article body or full markdown (frontmatter is ignored if still present).
 * @param frontmatter - Optional frontmatter facts to merge in.
 * @param title - Optional article title; used only as a fallback fact.
 * @param options - Extraction tuning.
 * @returns Ordered, deduplicated list of facts (max `maxFacts`).
 */
export function extractFactsFromMarkdown(
  markdown: string,
  frontmatter: {
    answerCapsule?: { keyPoints?: string[]; answer?: string } | null;
    description?: string;
  } = {},
  title?: string,
  options: ExtractFactsOptions = {},
): string[] {
  const opts: Required<ExtractFactsOptions> = { ...DEFAULT_OPTIONS, ...options };
  const seen = new Set<string>();
  const facts: string[] = [];

  const add = (raw: string, minLength = opts.minLength) => {
    const normalized = normalizeFact(raw, minLength, opts.maxLength);
    if (!normalized) return;
    const key = normalized.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    facts.push(normalized);
  };

  // Start with frontmatter facts — they are the most trusted (often from CAP).
  // Allow shorter facts from frontmatter (e.g., "Goal-setting", "Workflow").
  for (const f of buildFrontmatterFacts(frontmatter)) add(f, 8);

  // Strip frontmatter if the caller passed full raw markdown.
  const body = markdown.replace(/^---\n[\s\S]*?\n---\n?/, '').trim();

  // If we have nothing yet, the title itself is better than nothing.
  if (facts.length === 0 && title) add(title, 8);

  // Remove the H1 title from the body to avoid duplicating it.
  const bodyWithoutH1 = body.replace(/^#\s+.+$/m, '').trim();

  // 1. Bullet / numbered list items are usually the most fact-dense.
  if (opts.includeLists) {
    const listItemRegex = /^[ \t]*(?:[-*+]|\d+[.)])[ \t]+(.+)$/gm;
    let match: RegExpExecArray | null;
    while ((match = listItemRegex.exec(bodyWithoutH1)) !== null) {
      add(match[1]!);
    }
  }

  // 2. H2/H3 headings are often direct claims.
  if (opts.includeHeadings) {
    const headingRegex = /^#{2,3}[ \t]+(.+)$/gm;
    let match: RegExpExecArray | null;
    while ((match = headingRegex.exec(bodyWithoutH1)) !== null) {
      add(match[1]!);
    }
  }

  // 3. Bold phrases inside paragraphs are frequently key takeaways.
  if (opts.includeBold) {
    const boldRegex = /\*\*([^*\n]+)\*\*/g;
    let match: RegExpExecArray | null;
    while ((match = boldRegex.exec(bodyWithoutH1)) !== null) {
      add(match[1]!);
    }
  }

  // 4. First sentence of each non-empty, non-structural paragraph.
  // A paragraph is a consecutive run of plain lines (not headings/lists/frontmatter).
  if (opts.includeParagraphs) {
    const lines = bodyWithoutH1.split('\n');
    const flush = (buffer: string[]) => {
      if (buffer.length === 0) return;
      const text = buffer.join(' ').trim();
      if (text.length === 0) return;
      const firstSentence = text.split(/(?<=[.!?])\s+/)[0] ?? text;
      add(firstSentence);
    };

    let buffer: string[] = [];
    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (line.length === 0) {
        flush(buffer);
        buffer = [];
        continue;
      }
      if (
        line.startsWith('#') ||
        line.match(/^[ \t]*(?:[-*+]|\d+[.)])/) ||
        line.match(/^(title|date|tags|category|description|answerCapsule|seo)[ \t]*:/i)
      ) {
        flush(buffer);
        buffer = [];
        continue;
      }
      buffer.push(line);
    }
    flush(buffer);
  }

  return facts.slice(0, opts.maxFacts);
}
