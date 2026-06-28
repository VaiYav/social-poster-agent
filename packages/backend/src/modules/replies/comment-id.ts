import { createHash } from 'node:crypto';

/**
 * RP2: Build a stable, collision-resistant identifier for an incoming comment.
 *
 * The previous approach — `${author}-${text.slice(0,50)}`.replace(/[^a-zA-Z0-9]/g, '').slice(0,80) —
 * stripped every non-ASCII-alphanumeric character and truncated. For Cyrillic/emoji comments
 * (the primary audience) the result collapsed to nearly empty / to just the author, so distinct
 * comments by one author de-duplicated to a single `(postId, commentId)` record and real comments
 * were silently dropped.
 *
 * We hash the full author+text instead — stable across runs, unique per distinct comment regardless
 * of script. When a platform-native comment id is available it is preferred (`nativeId`).
 */

// Control-char separator (NUL) so ("a b","c") and ("a","b c") never collide on the same hash input.
const SEP = String.fromCharCode(0);

export function buildCommentId(author: string, text: string, nativeId?: string | null): string {
  const native = (nativeId ?? '').trim();
  if (native.length > 0) {
    return `n:${native}`.slice(0, 120);
  }
  const normalized = `${(author ?? '').trim()}${SEP}${(text ?? '').trim()}`;
  const hash = createHash('sha256').update(normalized, 'utf8').digest('hex').slice(0, 32);
  return `h:${hash}`;
}
