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
    'Сатурн делает круг за 29.5 лет. Всё. Это и есть возвращение Сатурна. И оно всё равно тебя разносит.',
    'Полтора часа смотрю на свою натальную карту. Кажется, мне нужно прилечь.',
    'Никто не говорит, как бесит Меркурий в Деве в переписке. Каждое сообщение превращается в черновик.',
    'Мой терапевт спросил, почему я перед сессиями проверяю Co-Star. Я не смогла объяснить.',
    'Думала, моё возвращение Сатурна будет духовным. По факту — плач в машине и смена работы.',
    'Горячий тейк: Меркурий ретроградный не виноват. Виноват прямой Меркурий в третьем доме с плохим аспектом.',
  ],
  uk: [
    'Сатурн робить коло за 29.5 років. Усе. Це і є повернення Сатурна. І воно все одно тебе розносить.',
    'Півтори години дивлюся на свою натальну карту. Здається, мені треба прилягти.',
    'Ніхто не каже, як дратує Меркурій у Діві в листуванні. Кожне повідомлення стає чернеткою.',
    'Мій терапевт запитав, чому я перед сесіями перевіряю Co-Star. Я не зміг пояснити.',
    'Думала, моє повернення Сатурна буде духовним. По факту — плач у машині і зміна роботи.',
    'Гарячий тейк: ретроградний Меркурій не винен. Винен прямий Меркурій у третьому будинку з поганим аспектом.',
  ],
  es: [
    'Saturno tarda 29.5 años en dar la vuelta. Ya está. Eso es el retorno de Saturno. Y aun así te destroza.',
    'Llevo una hora mirando mi carta natal. Creo que necesito acostarme.',
    'Nadie habla de lo molesto que es Mercurio en Virgo para los mensajes. Todo se convierte en un borrador.',
    'Mi terapeuta me preguntó por qué reviso Co-Star antes de las sesiones. No supe explicarlo.',
    'Pensé que mi retorno de Saturno sería espiritual. En realidad fue llorar en el coche y cambiar de trabajo.',
    'Opinión impopular: Mercurio retrógrado no es el problema. Es Mercurio directo en tu casa 3 con un mal aspecto.',
  ],
  it: [
    'Saturno impiega 29.5 anni per fare il giro. Tutto qui. Questo è il ritorno di Saturno. E ti distrugge lo stesso.',
    "È un'ora che fisso il mio tema natale. Credo di dovermi sdraiare.",
    'Nessuno dice quanto sia fastidioso Mercurio in Vergine per i messaggi. Tutto diventa una bozza.',
    'Il mio terapeuta mi ha chiesto perché controllo Co-Star prima delle sedute. Non sono riuscito a spiegarlo.',
    'Pensavo che il mio ritorno di Saturno sarebbe stato spirituale. In realtà è stato piangere in macchina e cambiare lavoro.',
    'Opinione impopolare: Mercurio retrogrado non è il problema. È Mercurio diretto nella terza casa con un brutto aspetto.',
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
