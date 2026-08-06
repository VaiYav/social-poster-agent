/**
 * Extract the first top-level JSON object from an LLM response string.
 *
 * Unlike a greedy `/\{[\s\S]*\}/` regex, this walks the text bracket-by-bracket
 * while respecting JSON string boundaries, so curly braces inside quoted reason
 * or replyText fields do not cause over-matching.
 */
export function extractFirstJsonObject<T = unknown>(raw: string): T | null {
  const firstBrace = raw.indexOf('{');
  if (firstBrace === -1) return null;

  let depth = 0;
  let inString = false;
  let escape = false;

  for (let i = firstBrace; i < raw.length; i++) {
    const c = raw[i];
    if (inString) {
      if (escape) {
        escape = false;
      } else if (c === '\\') {
        escape = true;
      } else if (c === '"') {
        inString = false;
      }
    } else {
      if (c === '"') {
        inString = true;
      } else if (c === '{') {
        depth++;
      } else if (c === '}') {
        depth--;
        if (depth === 0) {
          const candidate = raw.slice(firstBrace, i + 1);
          try {
            return JSON.parse(candidate) as T;
          } catch {
            return null;
          }
        }
      }
    }
  }

  return null;
}
