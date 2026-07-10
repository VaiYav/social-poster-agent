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
      'unlock', 'tapestry', 'embrace', 'vibrant', 'resonate', 'resonates', 'empowering',
      'transformative', 'powerful', 'profound', 'deeply', 'furthermore', 'additionally',
      'moreover', 'elevate', 'harness', 'unleash', 'testament', 'pivotal', 'groundbreaking',
      'game-changer', 'seamlessly', 'fascinating', 'captivating', 'compelling', 'notably',
      'significantly', 'crucial', 'essential', 'invaluable', 'reminder', 'nuance', 'interplay',
      'learnings', 'takeaways', 'insights', 'reflections', 'realizations', 'observations',
      'aligned', 'mindful', 'intentional', 'dance', 'vibes',
    ],
    phrases: [
      "in today's fast-paced world", "it's worth noting", "let's dive in",
      "here's the thing", "let's be real", 'fun fact:', 'did you know',
      'in conclusion', 'in summary', 'at the end of the day',
      'a gentle reminder', 'the universe has a way',
      'deep dive', 'let\'s unpack', 'unpack this', 'at the heart of',
      'game-changing', 'value-add', 'a whole new level', 'the key is',
      'the secret to', 'the truth about', 'what nobody tells you',
      'this changes everything', 'the only guide', 'you need to know',
      'here\'s why', 'here\'s what', 'let me tell you', 'don\'t ignore',
      'pay attention', 'in the world of', 'in a world where',
      'we need to talk about', 'no one talks about', 'nobody talks about',
      'the problem with', 'the thing about', 'the catch', 'the kicker',
      'plot twist', 'spoiler alert', 'unpopular opinion', 'hot take:',
      'just saying', 'real talk', 'brutally honest', 'hard truth',
      'uncomfortable truth', 'the real reason', 'the one thing',
      'often overlooked', 'frequently overlooked', 'this is your sign',
      'this is the sign', 'your sign to', 'psa:', 'friendly reminder',
      'reminder that', 'don\'t forget', 'save this', 'bookmark this',
      'share this', 'tag someone', 'tag a friend', 'you heard it here first',
    ],
  },
  ru: {
    words: [
      'погрузиться', 'погружаемся', 'раскрыть', 'раскроем', 'преобразить',
      'вдохновляющий', 'уникальный', 'незабываемый', 'судьбоносный',
      'всеобъемлющий', 'гармоничный', 'трансформация', 'энергетика',
      'инсайты', 'выводы', 'размышления', 'осознания', 'наблюдения',
      'выровненный', 'осознанный', 'намеренный', 'откликается', 'вибрации', 'танец',
    ],
    phrases: [
      'в современном мире', 'давайте разберёмся', 'давайте разберемся',
      'не секрет, что', 'каждый из нас', 'в наше время', 'стоит отметить',
      'важно понимать', 'как известно', 'это не просто', 'а знаете ли вы',
      'знаете ли вы', 'подводя итог', 'в заключение', 'мир астрологии',
      'откройте для себя', 'погрузитесь в мир', 'ключ к пониманию себя',
      'глубокое погружение', 'давайте разберём', 'в самом сердце', 'играющий',
      'новый уровень', 'ключ в том', 'секрет', 'правда о', 'что вам не говорят',
      'это меняет всё', 'единственный гид', 'вот почему', 'вот что', 'не игнорируйте',
      'обратите внимание', 'в мире', 'в мире, где', 'нам нужно поговорить',
      'никто не говорит', 'никто не говорит о', 'проблема в том', 'вот в чём прикол',
      'непопулярное мнение', 'горячее мнение', 'просто говорю', 'честно говоря',
      'жесткая правда', 'неудобная правда', 'настоящая причина', 'единственная вещь',
      'часто упускают', 'часто упускают из виду', 'это ваш знак', 'ваш знак, чтобы',
      'дружеское напоминание', 'напоминание, что', 'не забудьте', 'сохраните это',
      'поделитесь', 'отметьте друга', 'вы услышали это первым',
    ],
  },
  uk: {
    words: [
      'зануритися', 'розкрити', 'розкриємо', 'перетворити', 'надихаючий',
      'унікальний', 'незабутній', 'доленосний', 'всеосяжний', 'гармонійний',
      'трансформація', 'енергетика',
      'інсайти', 'висновки', 'роздуми', 'усвідомлення', 'спостереження',
      'вирівняний', 'усвідомлений', 'намірений', 'відгукується', 'вібрації', 'танець',
    ],
    phrases: [
      'у сучасному світі', 'в сучасному світі', "давайте розберемося",
      'не секрет, що', 'кожен із нас', 'кожен з нас', 'у наш час',
      'варто зазначити', 'важливо розуміти', 'як відомо', 'це не просто',
      'а чи знаєте ви', 'чи знаєте ви', 'підсумовуючи', 'на завершення',
      'світ астрології', 'відкрийте для себе', 'зануртеся у світ',
      'глибоке занурення', 'давайте розберемо', 'у самому серці', 'новий рівень',
      'ключ у тому', 'секрет', 'правда про', 'що вам не кажуть', 'це змінює все',
      'єдиний гід', 'ось чому', 'ось що', 'не ігноруйте', 'зверніть увагу',
      'у світі', 'у світі, де', 'нам потрібно поговорити', 'ніхто не говорить',
      'проблема в тому', 'ось у чому прикол', 'непопулярна думка', 'гостра думка',
      'просто кажу', 'чесно кажучи', 'жорстка правда', 'неприємна правда',
      'справжня причина', 'єдина річ', 'часто упускають', 'часто упускають з виду',
      'це ваш знак', 'ваш знак, щоб', 'дружнє нагадування', 'нагадування, що',
      'не забудьте', 'збережіть це', 'поділіться', 'позначте друга', 'ви почули це першим',
    ],
  },
  es: {
    words: [
      'sumergirse', 'sumérgete', 'descubre', 'desbloquea', 'transformador',
      'empoderador', 'inolvidable', 'fascinante', 'profundamente', 'además',
      'asimismo', 'inspirador',
      'aprendizajes', 'conclusiones', 'reflexiones', 'realizaciones', 'observaciones',
      'resuena', 'vibras', 'danza', 'alineado', 'consciente', 'intencional',
    ],
    phrases: [
      'en el mundo actual', 'en la actualidad', 'cabe destacar',
      'es importante entender', 'no es un secreto que', 'cada uno de nosotros',
      'sabías que', '¿sabías que', 'en conclusión', 'en resumen',
      'el mundo de la astrología', 'descubre el poder',
      'inmersión profunda', 'vamos a desglosar', 'en el corazón de',
      'cambio de juego', 'valor agregado', 'un nuevo nivel', 'la clave es',
      'el secreto de', 'la verdad sobre', 'lo que nadie te dice', 'esto lo cambia todo',
      'la única guía', 'necesitas saber', 'aquí está por qué', 'aquí está lo que',
      'no ignores', 'presta atención', 'en el mundo de', 'en un mundo donde',
      'necesitamos hablar', 'nadie habla de', 'el problema es', 'el truco es',
      'opinión impopular', 'opinión controversial', 'sólo digo', 'hablando en serio',
      'verdad dura', 'verdad incómoda', 'la verdadera razón', 'la única cosa',
      'a menudo pasado por alto', 'frecuentemente pasado por alto', 'esta es tu señal',
      'tu señal para', 'recordatorio amistoso', 'recordatorio de que', 'no olvides',
      'guarda esto', 'comparte esto', 'etiqueta a alguien', 'etiqueta a un amigo',
      'lo escuchaste aquí primero',
    ],
  },
  it: {
    words: [
      'immergersi', 'immergiti', 'scopri', 'sblocca', 'trasformativo',
      'potenziante', 'indimenticabile', 'affascinante', 'profondamente',
      'inoltre', 'ispirante',
      'apprendimenti', 'conclusioni', 'riflessioni', 'realizzazioni', 'osservazioni',
      'risuona', 'vibe', 'danza', 'allineato', 'consapevole', 'intenzionale',
    ],
    phrases: [
      'nel mondo di oggi', 'al giorno d\'oggi', 'vale la pena notare',
      'è importante capire', 'non è un segreto che', 'ognuno di noi',
      'lo sapevi che', 'sapevi che', 'in conclusione', 'in sintesi',
      'il mondo dell\'astrologia', 'scopri il potere',
      'approfondimento', 'andiamo a analizzare', 'nel cuore di',
      'cambiamento radicale', 'valore aggiunto', 'un nuovo livello', 'la chiave è',
      'il segreto per', 'la verità su', 'cosa che nessuno ti dice', 'cambia tutto',
      'l\'unica guida', 'devi sapere', 'ecco perché', 'ecco cosa', 'non ignorare',
      'fai attenzione', 'nel mondo di', 'in un mondo in cui', 'dobbiamo parlarne',
      'nessuno parla di', 'il problema è', 'il trucco è', 'opinione impopolare',
      'opinione scomoda', 'sto solo dicendo', 'parlando seriamente', 'verità dura',
      'verità scomoda', 'la vera ragione', 'l\'unica cosa', 'spesso trascurato',
      'frequentemente trascurato', 'questo è il tuo segno', 'il tuo segno per',
      'promemoria amichevole', 'promemoria che', 'non dimenticare', 'salva questo',
      'condividi questo', 'tagga qualcuno', 'tagga un amico', 'l\'hai sentito qui per primo',
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

export function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
