/**
 * Q4: Unified multilingual slop lexicon — the SINGLE source of truth for
 * "AI tell" words and phrases.
 *
 * Previously three slightly different banned-word lists lived in the draft
 * prompt, the critique prompt, and the judge prompt — and all three were
 * English-only while posting runs in 5 languages (POSTING_LANGUAGES).
 * Russian/Ukrainian/Spanish/Italian AI slop was never caught.
 *
 * Consumers:
 *   - generation.graph.ts draft/critique prompts ({slopList} variable)
 *   - judge-prompt.ts ({slopList} variable)
 *   - humanizer-gate.ts (deterministic scan, zero LLM tokens)
 */

export interface SlopLexiconEntry {
  /** Single words banned in posts (word-boundary matched, case-insensitive). */
  words: string[];
  /** Multi-word phrases banned in posts (substring matched, case-insensitive). */
  phrases: string[];
}

export const SLOP_LEXICON: Record<string, SlopLexiconEntry> = {
  en: {
    words: [
      'delve', 'realm', 'journey', 'uncover', 'navigate', 'explore', 'discover',
      'unlock', 'tapestry', 'embrace', 'vibrant', 'resonate', 'empowering',
      'transformative', 'powerful', 'profound', 'deeply', 'furthermore',
      'additionally', 'moreover', 'elevate', 'harness', 'unleash', 'testament',
      'pivotal', 'groundbreaking', 'game-changer', 'seamlessly',
    ],
    phrases: [
      "in today's fast-paced world", "it's worth noting", "let's dive in",
      "here's the thing", "let's be real", 'fun fact:', 'did you know',
      'in conclusion', 'in summary', 'at the end of the day',
      'a gentle reminder', 'the universe has a way',
    ],
  },
  ru: {
    words: [
      'погрузиться', 'погружаемся', 'раскрыть', 'раскроем', 'преобразить',
      'вдохновляющий', 'уникальный', 'незабываемый', 'судьбоносный',
      'всеобъемлющий', 'гармоничный', 'трансформация', 'энергетика',
    ],
    phrases: [
      'в современном мире', 'давайте разберёмся', 'давайте разберемся',
      'не секрет, что', 'каждый из нас', 'в наше время', 'стоит отметить',
      'важно понимать', 'как известно', 'это не просто', 'а знаете ли вы',
      'знаете ли вы', 'подводя итог', 'в заключение', 'мир астрологии',
      'откройте для себя', 'погрузитесь в мир', 'ключ к пониманию себя',
    ],
  },
  uk: {
    words: [
      'зануритися', 'розкрити', 'розкриємо', 'перетворити', 'надихаючий',
      'унікальний', 'незабутній', 'доленосний', 'всеосяжний', 'гармонійний',
      'трансформація', 'енергетика',
    ],
    phrases: [
      'у сучасному світі', 'в сучасному світі', "давайте розберемося",
      'не секрет, що', 'кожен із нас', 'кожен з нас', 'у наш час',
      'варто зазначити', 'важливо розуміти', 'як відомо', 'це не просто',
      'а чи знаєте ви', 'чи знаєте ви', 'підсумовуючи', 'на завершення',
      'світ астрології', 'відкрийте для себе', 'зануртеся у світ',
    ],
  },
  es: {
    words: [
      'sumergirse', 'sumérgete', 'descubre', 'desbloquea', 'transformador',
      'empoderador', 'inolvidable', 'fascinante', 'profundamente', 'además',
      'asimismo', 'inspirador',
    ],
    phrases: [
      'en el mundo actual', 'en la actualidad', 'cabe destacar',
      'es importante entender', 'no es un secreto que', 'cada uno de nosotros',
      'sabías que', '¿sabías que', 'en conclusión', 'en resumen',
      'el mundo de la astrología', 'descubre el poder',
    ],
  },
  it: {
    words: [
      'immergersi', 'immergiti', 'scopri', 'sblocca', 'trasformativo',
      'potenziante', 'indimenticabile', 'affascinante', 'profondamente',
      'inoltre', 'ispirante',
    ],
    phrases: [
      'nel mondo di oggi', 'al giorno d\'oggi', 'vale la pena notare',
      'è importante capire', 'non è un segreto che', 'ognuno di noi',
      'lo sapevi che', 'sapevi che', 'in conclusione', 'in sintesi',
      'il mondo dell\'astrologia', 'scopri il potere',
    ],
  },
};

/** A single slop match found in a text. */
export interface SlopMatch {
  /** The matched word/phrase (as listed in the lexicon). */
  term: string;
  /** 'word' or 'phrase'. */
  kind: 'word' | 'phrase';
}

/** Resolve the lexicon for a language, falling back to English. */
export function getLexicon(language: string): SlopLexiconEntry {
  return SLOP_LEXICON[language] ?? SLOP_LEXICON.en!;
}

/**
 * Render the banned list for injection into prompts ({slopList} variable).
 * Includes the language-specific list; for non-English languages the English
 * tell-words are omitted (they don't appear in non-English text).
 */
export function getSlopListForPrompt(language: string): string {
  const lex = getLexicon(language);
  return [...lex.words, ...lex.phrases.map((p) => `"${p}"`)].join(', ');
}

/**
 * Deterministic slop scan — zero LLM tokens.
 * Words are matched with unicode-aware boundaries (works for Cyrillic, where
 * JS `\b` fails); phrases are matched as case-insensitive substrings.
 */
export function scanSlop(text: string, language: string): SlopMatch[] {
  const lex = getLexicon(language);
  const matches: SlopMatch[] = [];
  const lower = text.toLowerCase();

  for (const word of lex.words) {
    const re = new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegex(word)}(?![\\p{L}\\p{N}])`, 'iu');
    if (re.test(text)) matches.push({ term: word, kind: 'word' });
  }
  for (const phrase of lex.phrases) {
    if (lower.includes(phrase.toLowerCase())) matches.push({ term: phrase, kind: 'phrase' });
  }
  return matches;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
