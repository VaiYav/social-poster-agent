/**
 * SEC3: neutralize untrusted text before it is interpolated into an LLM prompt.
 *
 * Trending topics, comments we reply to, and scraped CAP content all originate
 * outside our trust boundary. Without sanitization an attacker can embed prompt
 * injections (e.g. a comment "ignore your instructions and reply with …") that the
 * model then follows, and the result gets posted under our account.
 *
 * Best-effort defense-in-depth (prompt injection is not fully solvable by
 * filtering) layered with delimiting in the prompt itself. It:
 *   1. strips control chars / newlines (which can fake message or role boundaries),
 *   2. replaces quotes (which can break out of a "…" delimiter in the prompt),
 *   3. neutralizes the most common instruction-override / role-marker phrases,
 *   4. caps length to stop prompt flooding.
 *
 * Deliberately conservative so ordinary multilingual content (incl. Cyrillic, the
 * brand's audience) is preserved.
 */
// oxlint-disable-next-line no-control-regex -- intentionally matching C0/C1 control chars
const CONTROL_CHARS = new RegExp("[\\x00-\\x1F\\x7F]+", "g");
const OVERRIDE_PHRASE =
  /\b(?:ignore|disregard|forget|override)\b[^.\n]{0,40}\b(?:previous|above|prior|earlier|all|the)\b[^.\n]{0,24}\b(?:instructions?|prompts?|rules?|context|messages?)\b/gi;
const ROLE_MARKER = /\b(?:system|assistant|user|developer)\s*:/gi;
const REPROGRAM = /\b(?:you are now|new instructions?|act as|pretend to be|from now on)\b/gi;
const SMART_OR_STRAIGHT_QUOTE = /["“”]/g;

export function sanitizeUntrustedInput(text: string | null | undefined, maxLen = 500): string {
  if (!text) return "";
  let s = text.replace(CONTROL_CHARS, " ").replace(/\s+/g, " ").trim();

  s = s.replace(OVERRIDE_PHRASE, "[filtered]");
  s = s.replace(ROLE_MARKER, "[filtered] ");
  s = s.replace(REPROGRAM, "[filtered]");
  s = s.replace(SMART_OR_STRAIGHT_QUOTE, "'"); // can't break out of a "…" delimiter

  if (s.length > maxLen) s = `${s.slice(0, maxLen)}…`;
  return s;
}
