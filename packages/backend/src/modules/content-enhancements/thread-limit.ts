/**
 * AU8: enforce a per-tweet character limit on a thread continuation.
 *
 * Thread continuations (LLM- or heuristic-generated) were posted verbatim with no length check,
 * so an over-limit continuation would be rejected or silently truncated by X, breaking the thread.
 * This truncates to <= limit code points, cutting at a word boundary where possible and appending
 * a single-code-point ellipsis.
 */
export function truncateForThread(text: string, limit = 280): string {
  const trimmed = (text ?? '').trim();
  const chars = [...trimmed]; // count by Unicode code points, not UTF-16 units
  if (chars.length <= limit) return trimmed;

  const budget = Math.max(1, limit - 1); // reserve 1 code point for the ellipsis
  let cut = chars.slice(0, budget).join('');
  const lastSpace = cut.lastIndexOf(' ');
  if (lastSpace > budget * 0.6) {
    cut = cut.slice(0, lastSpace);
  }
  return `${cut.trimEnd()}…`;
}
