import type { ContentTopic } from "@spa/shared";

/**
 * A6: extracted from GenerationService (god-object split, step 1).
 *
 * B5 topic prioritization — pure, no I/O, no logging:
 *   1. sort freshest-first (publishedAt desc; undated topics go last), then
 *   2. pick up to `count` topics round-robin across categories, so consecutive
 *      picks avoid repeating the same category where possible.
 *
 * GenerationService keeps a thin wrapper that adds the B5 debug log.
 */
export function prioritizeTopics(topics: ContentTopic[], count: number): ContentTopic[] {
  // Sort by publishedAt descending (freshest first); topics without a date go last.
  const sorted = [...topics].sort((a, b) => {
    const aTime = a.publishedAt?.getTime() ?? 0;
    const bTime = b.publishedAt?.getTime() ?? 0;
    return bTime - aTime;
  });

  // Rotate categories — pick topics round-robin from different categories.
  const result: ContentTopic[] = [];
  const remaining = [...sorted];
  let lastCategory: string | null = null;

  while (remaining.length > 0 && result.length < count) {
    // First topic whose category differs from the last picked one.
    let idx = remaining.findIndex((t) => (t.category ?? "uncategorized") !== lastCategory);
    // If all remaining share the last category, just take the first.
    if (idx === -1) idx = 0;

    const picked = remaining.splice(idx, 1)[0]!;
    result.push(picked);
    lastCategory = picked.category ?? "uncategorized";
  }

  return result;
}
