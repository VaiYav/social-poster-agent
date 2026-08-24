export interface GroundingConflictInput {
  readonly id: string;
  readonly text: string;
  readonly sourceType: string;
}

export interface GroundingConflict {
  readonly leftId: string;
  readonly rightId: string;
  readonly leftSourceType: string;
  readonly rightSourceType: string;
  readonly overlap: number;
  readonly reason: "OPPOSING_POLARITY_REVIEW_REQUIRED";
}

const NEGATIVE_MARKERS = new Set([
  "not",
  "never",
  "no",
  "avoid",
  "cannot",
  "cant",
  "shouldnt",
  "harmful",
  "decrease",
  "reduce",
]);
const STOP_WORDS = new Set([
  "a",
  "an",
  "and",
  "are",
  "be",
  "can",
  "does",
  "for",
  "in",
  "is",
  "it",
  "of",
  "on",
  "or",
  "the",
  "to",
  "with",
]);

export function detectGroundingConflicts(
  items: readonly GroundingConflictInput[],
): GroundingConflict[] {
  const conflicts: GroundingConflict[] = [];
  for (let leftIndex = 0; leftIndex < items.length; leftIndex++) {
    const left = items[leftIndex]!;
    const leftTokens = subjectTokens(left.text);
    const leftNegative = hasNegativePolarity(left.text);
    for (let rightIndex = leftIndex + 1; rightIndex < items.length; rightIndex++) {
      const right = items[rightIndex]!;
      if (leftNegative === hasNegativePolarity(right.text)) continue;
      const overlap = jaccard(leftTokens, subjectTokens(right.text));
      if (overlap < 0.6) continue;
      conflicts.push({
        leftId: left.id,
        rightId: right.id,
        leftSourceType: left.sourceType,
        rightSourceType: right.sourceType,
        overlap: Math.round(overlap * 1000) / 1000,
        reason: "OPPOSING_POLARITY_REVIEW_REQUIRED",
      });
    }
  }
  return conflicts;
}

function subjectTokens(text: string): Set<string> {
  return new Set(
    tokenize(text).filter((token) => !STOP_WORDS.has(token) && !NEGATIVE_MARKERS.has(token)),
  );
}

function tokenize(text: string): string[] {
  return text.toLowerCase().match(/[a-z0-9]+/g) ?? [];
}

function hasNegativePolarity(text: string): boolean {
  return tokenize(text).some((token) => NEGATIVE_MARKERS.has(token));
}

function jaccard(left: Set<string>, right: Set<string>): number {
  if (left.size === 0 || right.size === 0) return 0;
  let intersection = 0;
  for (const token of left) if (right.has(token)) intersection++;
  return intersection / (left.size + right.size - intersection);
}
