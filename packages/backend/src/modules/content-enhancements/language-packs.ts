/**
 * Q12: Per-language voice packs — native few-shot examples for the draft prompt.
 *
 * The draft prompt's inline good/bad examples are English. For ru/uk/es/it the
 * model either translates them as calque ("sounds translated") or ignores them.
 * These packs give 3 short NATIVE examples of the target voice per language so
 * burstiness/tone/register transfer into the right language.
 *
 * en returns '' — the English examples already live in the draft prompt.
 */

const PACKS: Record<string, string[]> = {
  ru: [
    'Sprint review занял три часа. Всё. Это и есть ретро. И оно всё равно всех раздражает.',
    'Полтора часа разбираю логи. Кажется, мне нужно отдохнуть.',
    'Никто не говорит, как бесит пятничный релиз. Каждый фикс превращается в новый баг.',
    'Мой менеджер спросил, почему я перед демо проверяю метрики. Я не смог объяснить.',
    'Думал, запуск фичи будет триумфом. По факту — правка опечаток и новый флажок в конфиге.',
    'Горячий тейк: дедлайн не виноват. Виноват тот, кто в него поверил.',
  ],
  uk: [
    'Sprint review зайняв три години. Усе. Це і є ретро. І воно все одно всіх дратує.',
    'Півтори години розбираю логи. Здається, мені треба відпочити.',
    'Ніхто не каже, як дратує п\'ятничний реліз. Кожен фікс стає новим багом.',
    'Мій менеджер запитав, чому я перед демо перевіряю метрики. Я не зміг пояснити.',
    'Думав, запуск фічі буде тріумфом. По факту — правка опечаток і новий прапорець у конфіг.',
    'Гарячий тейк: дедлайн не винен. Винен той, хто в нього повірив.',
  ],
  es: [
    'La sprint review duró tres horas. Ya está. Eso es el retro. Y aun así molesta a todos.',
    'Llevo una hora y media revisando logs. Creo que necesito descansar.',
    'Nadie habla de lo molesto que es un release del viernes. Cada fix se convierte en un bug nuevo.',
    'Mi manager me preguntó por qué reviso métricas antes de la demo. No supe explicarlo.',
    'Pensé que el lanzamiento de la feature sería un triunfo. En realidad fue correr typos y una nueva flag en config.',
    'Opinión impopular: el deadline no es el problema. Es quien creyó en él.',
  ],
  it: [
    'La sprint review è durata tre ore. Tutto qui. Questo è il retro. E irrita tutti allo stesso modo.',
    "È da un'ora e mezza che guardo i log. Credo di dovermi riposare.",
    'Nessuno dice quanto sia fastidioso il rilascio del venerdì. Ogni fix diventa un nuovo bug.',
    'Il mio manager mi ha chiesto perché controllo le metriche prima della demo. Non sono riuscito a spiegarlo.',
    'Pensavo che il lancio della feature sarebbe stato un trionfo. In realtà è stato correggere typo e aggiungere una flag nella config.',
    'Opinione impopolare: la deadline non è il problema. È chi ci ha creduto.',
  ],
};

/**
 * Render the native-voice examples block for the draft prompt ({langExamples}).
 * Returns '' for English (examples are already inline) and unknown languages.
 */
export function getLanguageExamples(language: string): string {
  const pack = PACKS[language];
  if (!pack || pack.length === 0) return '';
  return (
    '\n\nNATIVE VOICE EXAMPLES for this language (match the ENERGY and rhythm — do NOT copy the content):\n' +
    pack.map((e) => `- "${e}"`).join('\n') +
    '\n'
  );
}
