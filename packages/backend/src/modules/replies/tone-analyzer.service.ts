/**
 * F4: Lightweight tone analyzer for incoming comments.
 *
 * Determines the emotional/linguistic tone of the latest user message so the
 * reply-generation prompt can match it (casual → casual, formal → measured,
 * playful → playful, sarcastic → dry, sincere → warm).
 *
 * This is intentionally rule-based rather than an extra LLM call — the reply
 * LLM already generates text; we only need a fast, cheap signal to steer it.
 */
import { Injectable } from "@nestjs/common";

export type CommentTone = "casual" | "formal" | "playful" | "sarcastic" | "sincere" | "neutral";

export interface ToneAnalysis {
  tone: CommentTone;
  confidence: number;
  reason: string;
}

const EMOJI_RE =
  /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2190}-\u{21FF}\u{2B00}-\u{2BFF}\uFE0F\u200D]/gu;

const CASUAL_MARKERS = new Set([
  // English
  "lol",
  "lmao",
  "haha",
  "cool",
  "nice",
  "thanks",
  "thx",
  "ty",
  "ok",
  "okay",
  "yeah",
  "yep",
  "nope",
  "gonna",
  "wanna",
  "gotta",
  "kinda",
  "sorta",
  "tbh",
  "imo",
  "imho",
  "fr",
  "ngl",
  "idk",
  "rn",
  // Russian / Ukrainian
  "прикол",
  "круто",
  "супер",
  "ок",
  "спс",
  "пасиб",
  "да",
  "нет",
  "ого",
  "ух",
  "блин",
  "класс",
  "ахах",
  "хаха",
  "хіхі",
  "дякую",
  "дяки",
  "агонь",
  "топ",
  "база",
  // Spanish / Italian
  "jaja",
  "jeje",
  "vale",
  "pues",
  "bueno",
  "dai",
  "tipo",
  "tio",
  "tia",
  "che",
  "mah",
  "boh",
  "guay",
  "genial",
  "ok",
  "bene",
  "bella",
  "simpatica",
]);

const FORMAL_MARKERS = new Set([
  "dear",
  "sir",
  "madam",
  "regards",
  "sincerely",
  "regarding",
  "concerning",
  "would",
  "could",
  "should",
  "please",
  "appreciate",
  "request",
  "inquiry",
  // RU/UA
  "уважаемый",
  "уважаемая",
  "прошу",
  "будьте",
  "добры",
  "относительно",
  "касательно",
  "щодо",
  "шановний",
  "шановна",
  // Spanish / Italian
  "por",
  "favor",
  "gentile",
  "cordiali",
  "saluti",
  "distinti",
  "porgo",
  "distinti saluti",
]);

const FORMAL_PHRASES = new Set([
  "please clarify",
  "could you please",
  "would you please",
  "i would appreciate",
  "thank you in advance",
  // RU/UA
  "прошу вас",
  "будьте добры",
  "доброго дня",
  "доброго ранку",
  "добрий день",
  // Spanish / Italian
  "por favor",
  "le agradecería",
  "la ringrazio",
  "cordiali saluti",
  "distinti saluti",
]);

const SARCASM_MARKERS = new Set([
  "oh great",
  "nice one",
  "wow thanks",
  "as if",
  "obviously",
  "sure thing",
  "tell me about it",
  "love that for me",
  "just what i needed",
  "couldn't be better",
  "genius",
  "brilliant",
  // RU/UA
  "ну класс",
  "спасибо большое",
  "очень рад",
  "ясен пень",
  "конечно",
  "звичайно",
  "як чудово",
  // Spanish / Italian
  "genial",
  "perfecto",
  "justo lo que necesitaba",
  "otra vez",
  "gracias por nada",
  "por supuesto",
  "come sempre",
  "proprio quello che ci voleva",
  "perfetto",
]);

const SINCERE_MARKERS = new Set([
  "honestly",
  "truthfully",
  "genuinely",
  "really",
  "seriously",
  "appreciate",
  "grateful",
  "touched",
  "moved",
  "worried",
  "scared",
  "anxious",
  // RU/UA
  "чесно",
  "чесне",
  "щиро",
  "волнуюсь",
  "переживаю",
  "боюсь",
  // Spanish / Italian
  "gracias",
  "grazie",
  "sinceramente",
  "veramente",
  "grazie mille",
  "muchas gracias",
]);

const SINCERE_PHRASES = new Set([
  "mean a lot",
  "thank you so much",
  "thank you very much",
  "means the world",
  // RU/UA
  "спасибо большое",
  "дякую велике",
  "дякую тобі",
  "дякую за",
  // Spanish / Italian
  "muchas gracias",
  "gracias por",
  "ti voglio bene",
  "grazie di cuore",
]);

@Injectable()
export class ToneAnalyzerService {
  detectTone(text: string, detectedLanguage: string): ToneAnalysis {
    const t = (text ?? "").toLowerCase();
    const tokens = t
      .replace(/[^\p{L}\p{N}\s]/gu, " ")
      .split(/\s+/)
      .filter(Boolean);

    // match() does not mutate lastIndex on a global regex; test() does.
    const hasEmoji = text.match(EMOJI_RE) !== null;
    const exclamationCount = (t.match(/!/g) ?? []).length;
    const questionCount = (t.match(/\?/g) ?? []).length;

    // Count uppercase letters across all scripts (\p{Lu}) against all letters (\p{L}).
    // Guard against 0/0 for emoji-only or non-alphabetic text.
    const upperCount = (text.match(/\p{Lu}/gu) ?? []).length;
    const letterCount = (text.match(/\p{L}/gu) ?? []).length;
    const allCapsRatio = letterCount > 0 ? upperCount / letterCount : 0;

    const scores: Record<CommentTone, number> = {
      casual: 0,
      formal: 0,
      playful: 0,
      sincere: 0,
      sarcastic: 0,
      neutral: 0,
    };

    for (const token of tokens) {
      if (CASUAL_MARKERS.has(token)) scores.casual += 1;
      if (FORMAL_MARKERS.has(token)) scores.formal += 1;
      if (SINCERE_MARKERS.has(token)) scores.sincere += 1;
    }

    // Multi-word phrases are matched as whole phrases; markers are case-folded below.
    for (const marker of FORMAL_PHRASES) {
      if (t.includes(marker)) scores.formal += 1;
    }
    for (const marker of SINCERE_PHRASES) {
      if (t.includes(marker)) scores.sincere += 1;
    }

    // Sarcasm often shows up as multi-word phrases. Check those as substrings
    // while the other marker sets work on single-token matches.
    for (const marker of SARCASM_MARKERS) {
      if (t.includes(marker)) scores.sarcastic += 1;
    }

    if (hasEmoji) {
      scores.playful += 2;
      scores.casual += 1;
    }
    if (exclamationCount > 0) {
      scores.playful += 1;
      scores.casual += 0.5;
    }
    if (allCapsRatio > 0.3 && text.length > 3) {
      scores.playful += 1.5;
      scores.sarcastic += 0.5;
    }
    if (questionCount > 0) {
      scores.sincere += 0.5;
      scores.formal += 0.5;
    }

    // Pick the highest-scoring tone. Tie-break: prefer neutral for low scores.
    const entries = Object.entries(scores) as [CommentTone, number][];
    entries.sort((a, b) => b[1] - a[1]);
    const [tone, maxScore] = entries[0]!;

    if (maxScore < 1) {
      return { tone: "neutral", confidence: 0.6, reason: "No strong tone markers detected" };
    }

    const total = Math.max(
      1,
      entries.reduce((sum, [, s]) => sum + s, 0),
    );
    const confidence = Math.min(1, Math.max(0.4, maxScore / total + 0.2));
    return {
      tone,
      confidence,
      reason: `${tone} tone (score ${maxScore.toFixed(1)}) in ${detectedLanguage}`,
    };
  }
}
