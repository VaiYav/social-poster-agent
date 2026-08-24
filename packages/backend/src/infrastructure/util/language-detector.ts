/**
 * Language detection wrapper powered by TinyLD.
 *
 * TinyLD is a pure-JS, zero-dependency n-gram language detector trained on
 * Tatoeba + UDHR that is specifically designed to work on short social/chat
 * text. It supports 62 languages and returns ISO-639-1 codes.
 *
 * We restrict the output to the five supported SPA languages (en, ru, uk, es, it)
 * and fall back to a script-based heuristic when TinyLD returns an unsupported
 * code or is called on empty input.
 *
 * Why not a hand-rolled heuristic? TinyLD outperforms simple script + keyword
 * checks on mixed-script short text (e.g. "bonjour productivité" → fr) and is
 * far more maintainable than growing ad-hoc word lists per language.
 */

import { detect } from "tinyld";
import type { SupportedLanguage } from "./script-check.js";

const SUPPORTED_LANGS: ReadonlySet<string> = new Set(["en", "ru", "uk", "es", "it"]);

const CYRILLIC_RE = /[\u0400-\u04FF]/g;
const LATIN_RE = /[a-zA-Z]/g;

const UKRAINIAN_CHARS_RE = /[іїєґ]/i;
const RUSSIAN_CHARS_RE = /[ыэёъ]/i;

/**
 * Fallback heuristic for the rare case TinyLD returns an unsupported code.
 * Primarily script-based, with a tiny vocabulary bias to keep it simple.
 */
function heuristicFallback(text: string): SupportedLanguage {
  if (!text || text.trim().length === 0) return "en";

  const cyrillicCount = (text.match(CYRILLIC_RE) ?? []).length;
  const latinCount = (text.match(LATIN_RE) ?? []).length;

  if (cyrillicCount >= latinCount && cyrillicCount > 0) {
    if (UKRAINIAN_CHARS_RE.test(text)) return "uk";
    if (RUSSIAN_CHARS_RE.test(text)) return "ru";
    return "ru";
  }

  return "en";
}

/**
 * Detect the dominant language of a short social text.
 *
 * Returns one of the supported languages: en, ru, uk, es, it.
 * Falls back to 'en' for empty or undetectable input.
 */
export function detectLanguage(text: string): SupportedLanguage {
  if (!text || text.trim().length === 0) return "en";

  const raw = detect(text);
  if (SUPPORTED_LANGS.has(raw)) {
    return raw as SupportedLanguage;
  }

  // TinyLD sometimes returns ISO-639-2/3 codes or 'und' for very short input.
  // Map common related codes and fall back to the heuristic for the rest.
  const iso2Map: Record<string, SupportedLanguage> = {
    eng: "en",
    rus: "ru",
    ukr: "uk",
    spa: "es",
    ita: "it",
  };
  if (raw.length === 3 && raw in iso2Map) {
    return iso2Map[raw]!;
  }

  return heuristicFallback(text);
}

/**
 * Confidence gate. TinyLD is generally reliable on short text, but this
 * function lets callers decide whether to trust the label blindly or ask the
 * LLM to confirm.
 */
export function isLanguageDetectable(text: string): boolean {
  if (!text || text.trim().length < 3) return false;
  const cyrillicCount = (text.match(CYRILLIC_RE) ?? []).length;
  const latinCount = (text.match(LATIN_RE) ?? []).length;
  return cyrillicCount + latinCount >= 3;
}
