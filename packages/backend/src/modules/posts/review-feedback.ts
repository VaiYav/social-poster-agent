import { createHash } from "node:crypto";

/** A stable decision vocabulary persisted in PostReviewDecision.decision. */
export type ReviewDecision = "APPROVE_UNCHANGED" | "APPROVE_EDITED" | "REJECT";

export function hashReviewContent(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

/**
 * Unicode-aware Levenshtein distance normalized to [0, 1]. Code points are
 * used instead of UTF-16 code units so emoji and non-BMP scripts count as one
 * user-visible character.
 */
export function normalizedEditDistance(original: string, finalContent: string): number {
  const left = Array.from(original);
  const right = Array.from(finalContent);
  if (left.length === 0 && right.length === 0) return 0;

  let previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let i = 1; i <= left.length; i += 1) {
    const current = [i];
    for (let j = 1; j <= right.length; j += 1) {
      current[j] = Math.min(
        current[j - 1]! + 1,
        previous[j]! + 1,
        previous[j - 1]! + (left[i - 1] === right[j - 1] ? 0 : 1),
      );
    }
    previous = current;
  }

  return previous[right.length]! / Math.max(left.length, right.length);
}
