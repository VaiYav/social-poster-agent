/**
 * Script validation for LLM-generated replies/comments.
 *
 * This is NOT language detection — it's a post-generation sanity check that
 * the LLM's reply actually uses the script of the language it claimed to
 * detect. This catches the #1 bot tell: replying in English to a non-English
 * comment.
 *
 * Why not full language detection here? The LLM is responsible for detecting
 * the language (per research: LLM detection is +3.1pp more accurate than
 * fastText, especially on short social media text). This module only validates
 * that the LLM's output is internally consistent — if it said "language: uk"
 * but wrote in Latin script, that's a mismatch we can catch deterministically.
 *
 * Supported languages: en, ru, uk, es, it.
 * - ru, uk → Cyrillic script expected
 * - en, es, it → Latin script expected
 */

export type SupportedLanguage = 'en' | 'ru' | 'uk' | 'es' | 'it';

const SUPPORTED_LANGS: readonly SupportedLanguage[] = ['en', 'ru', 'uk', 'es', 'it'];

const CYRILLIC_RE = /[\u0400-\u04FF]/g;
const LATIN_RE = /[a-zA-Z]/g;

/**
 * Languages that must use Cyrillic script.
 */
const CYRILLIC_LANGS: ReadonlySet<SupportedLanguage> = new Set(['ru', 'uk']);

/**
 * Languages that must use Latin script.
 */
const LATIN_LANGS: ReadonlySet<SupportedLanguage> = new Set(['en', 'es', 'it']);

/**
 * Check whether a text contains enough of the expected script to be plausible.
 *
 * We don't require 100% — social media text often mixes scripts (English
 * loanwords in a non-English post, emoji, hashtags). We require at least
 * one alphabetic character of the expected script, and that the "wrong"
 * script doesn't dominate.
 *
 * @param text - The LLM-generated reply/comment text
 * @param expectedLang - The language the LLM claimed to detect/write in
 * @returns true if the text's script is consistent with the expected language
 */
export function matchesScript(text: string, expectedLang: SupportedLanguage): boolean {
  if (!text || text.trim().length === 0) return true; // empty — let caller decide

  const cyrillicCount = (text.match(CYRILLIC_RE) ?? []).length;
  const latinCount = (text.match(LATIN_RE) ?? []).length;
  const totalAlpha = cyrillicCount + latinCount;

  // Not enough alphabetic content to judge (emoji-only, numbers) — accept
  if (totalAlpha < 2) return true;

  if (CYRILLIC_LANGS.has(expectedLang)) {
    // Expected Cyrillic — must have at least some Cyrillic, and it should
    // not be dominated by Latin (allowing for borrowed English terms)
    return cyrillicCount >= 1 && cyrillicCount >= latinCount;
  }

  if (LATIN_LANGS.has(expectedLang)) {
    // Expected Latin — must have at least some Latin, and Cyrillic should
    // not dominate (allowing for occasional Cyrillic quotes/names)
    return latinCount >= 1 && latinCount >= cyrillicCount;
  }

  // Unknown language — accept (let the LLM's judgement stand)
  return true;
}

/**
 * Normalise an arbitrary language code to one of our supported languages.
 * Falls back to 'en' for unknown codes.
 */
export function normalizeLanguage(code?: string | null): SupportedLanguage {
  if (!code) return 'en';
  const lower = code.toLowerCase().trim();
  if (SUPPORTED_LANGS.includes(lower as SupportedLanguage)) {
    return lower as SupportedLanguage;
  }
  if (lower.startsWith('ru')) return 'ru';
  if (lower.startsWith('uk')) return 'uk';
  if (lower.startsWith('es')) return 'es';
  if (lower.startsWith('it')) return 'it';
  if (lower.startsWith('en')) return 'en';
  return 'en';
}
