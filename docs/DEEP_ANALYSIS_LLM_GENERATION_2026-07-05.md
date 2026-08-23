# Deep Analysis: LLM-генерация SPA — корректность, качество, оптимизация

> **HISTORICAL RESEARCH SNAPSHOT.** Re-verify every finding against source. Current
> evaluation design is `docs/evaluation/`; implementation status is canonical only in
> `docs/planning/`.

> Дата: 2026-07-05. Скоуп: `modules/generation`, `infrastructure/llm`, `infrastructure/prompt`,
> `modules/content-enhancements`, `brand-voice.md`. Метод: чтение исходников + EXA-ресёрч
> (anti-AI-detection 2025-26, humor generation research: HumorGen/HumorPlanSearch/arXiv 2405.20956,
> платформенные стили X/Threads 2026).

## Вердикт (честно)

Архитектура пайплайна — выше среднего: fan-out по сетям, draft→critique→refine, LLM-judge,
bait-детектор, ротация стилей, персоны, кэши, circuit breaker. Задумка правильная.
Но: **в пайплайне есть 4 бага, которые прямо сейчас портят качество постов** (§1), промпты
конфликтуют сами с собой (§2.1), вся анти-AI машинерия работает только для английского,
хотя постинг идёт на 5 языках (§2.2), а judge — декоративный: его скоры никуда не подключены.
Юмор в промптах не операционализирован — «be funny» без механик даёт ровно тот
предсказуемый слоп, который вы баните списками слов.

---

## §1. Баги корректности — чинить первыми (P0)

### 1.1 `critique includes('good')` — refine почти всегда пропускается
`generation.graph.ts:866-868`:
```ts
const critiqueSaysGood = critiqueLower.includes('good') || critiqueLower.includes('no changes');
```
Критик пишет «The hook is good, but the rest sounds like AI» → substring `good` найден →
**refine пропущен, драфт уходит как есть**. Слово "good" встречается в большинстве развёрнутых
критик. Это тихо выключает треть пайплайна качества.

**Фикс:** критик уже обязан выводить маркер. Парсить строго:
```ts
const critiqueSaysGood = /^GOOD\b/m.test(netResult.critique) && (netResult.qualityScore ?? 0) >= 8;
```

### 1.2 Гонка temperature/maxTokens на общем ChatOpenAI
`llm.service.ts:465-490`: инстанс модели кэшируется per-provider, а потом мутируется:
```ts
model.temperature = options.temperature;  // shared mutable state
model.maxTokens = options?.maxTokens ?? -1;
```
Граф гоняет параллельно draft (t=0.7), critique (t=0.3), judge (t=0.2, maxTokens=300) по трём
сетям, плюс до 3 топиков одновременно (`MAX_CONCURRENCY=3`). Между присваиванием и `invoke()`
другой узел успевает перезаписать поля → **драфты периодически генерятся с t=0.2, а judge с t=0.9,
и judge может получить чужой maxTokens**. Недетерминированное качество, которое невозможно
отладить.

**Фикс (минимальный):** ключ кэша инстансов = `provider:model:temp:maxTokens`, никаких мутаций.
Или `model.bind({ temperature, maxTokens })` на вызов.

### 1.3 Правки ревьюера молча выбрасываются
`human_review` (graph.ts:1236-1244) пишет edits в `draft`, но `save_to_db` (graph.ts:1178) берёт
`refined || draft`. `refined` к этому моменту всегда заполнен (refine идёт раньше review по рёбрам)
→ **правки человека игнорируются**. Вдобавок ревьюеру показывают `draft`, а не `refined` —
он правит устаревший текст, которого уже нет.

**Фикс:** в interrupt-пейлоад отдавать `refined || draft`; edits писать в `refined`.

### 1.4 Fallback-заглушки нарушают собственные анти-AI правила
- `graph.ts:499`: если LLM вернул <3 хуков — добивается `"Discover what ${topic} means for you."` —
  слово *Discover* в вашем же banned-list, худший возможный хук.
- `graph.ts:360`: заглушка факта `"...offers unique insights for personal growth and self-awareness"` —
  чистый AI-слоп, уходит прямиком в draft-промпт как «факт».

**Фикс:** не добивать мусором. <3 хуков → перезапрос с ужесточённым промптом, затем fail топика.
Заглушки фактов — только нейтральные («No verified facts — write from the hook alone, do not invent stats»).

### 1.5 AB-варианты генерят хэштеги, которые запрещены политикой
`ab-variant.generator.ts:5-6`: вариант A = «1 hashtag», B = «2-3 hashtags». Весь остальной пайплайн
(brand-voice, draft-промпт, `stripHashtags`) хэштеги запрещает. Если posting-пайплайн опубликует
вариант B — нарушение собственной политики; если `stripHashtags` их срежет — A/B тест сравнивает
одно и то же. Фича противоречит сама себе. **Фикс:** варианты только по эмодзи/тону/длине.

### 1.6 Anthropic/MiMo — мёртвый конфиг
`.env.example:338-346` описывает `ANTHROPIC_MODEL=claude-haiku-4-5`, `MIMO_MODEL`, но
`buildProviderChain()` (llm.service.ts:155-272) их **не строит вообще**. Либо добавить провайдеров
(у Anthropic есть OpenAI-совместимый endpoint), либо убрать из env — сейчас это ловушка: ключ
поставят, а он не работает. Claude Haiku, к слову, для креатива/юмора заметно сильнее
llama-3.3-70b — его отсутствие в цепочке прямо бьёт по качеству (§4.1).

### 1.7 Judge: противоречивая инструкция + обрезка + слепая факт-проверка
`judge-prompt.ts:15-48` требует «сначала ENUMERATE… потом Respond as JSON only», при
`maxTokens: 300` (graph.ts:1086). Модель либо не enumerate'ит (CoT не работает), либо JSON
обрезается → парс падает → скоров нет. Плюс judge **не получает `state.facts`** — оценивает
`factual_accuracy` по собственной памяти, а не по источнику.

**Фикс:** убрать enumeration (или разрешить и парсить хвостовой JSON, cap 700), передать facts
в user-промпт, где поддерживается — `response_format: { type: 'json_object' }`.

---

## §2. Качество генераций: почему посты всё ещё пахнут ботом

### 2.1 brand-voice.md воюет с промптами графа
`brand-voice.md` инжектится ЦЕЛИКОМ в system prompt каждого draft/hook вызова. Внутри него:
- Примеры-хуки `"Did you know your Moon sign..."` (×2) — draft-промпт **банит** "Did you know".
- Столп бренда «**Empowering**» — слово в banned-list драфта и judge.
- Инструкции «Включать CTA», «Read your full chart at my-zodiac-ai.com», примеры постов с URL —
  draft-промпт запрещает URL и CTA.
- Tone-примеры «invites you to slow down and nurture yourself» — эталонный AI-слоп, который
  критик обязан завалить.

Модель получает взаимоисключающие указания в одном промпте. LLM в таком случае усредняет —
и это ровно та «стерильная середина», с которой вы боретесь. Плюс ~3-4K токенов балласта
в каждом вызове.

**Фикс:** переписать brand-voice.md под пайплайн (он старше анти-AI правил и не обновлялся):
выкинуть слоп-примеры, CTA/URL-секции, «Empowering» переформулировать; разбить на секции и
инжектить per-node только релевантное (identity ~400 токенов в draft; do/don't — в critique).
Экономия ~40% input-токенов draft-вызовов и устранение конфликта.

### 2.2 Анти-AI работает только на английском — а постите на 5 языках
`POSTING_LANGUAGES=en,ru,uk,es,it`, но:
- Все few-shot примеры (good/bad hooks, good/bad drafts) — английские.
- Banned-list — английский. Русский слоп никто не ловит: «в современном мире», «давайте
  разберёмся», «не секрет, что», «погрузиться в мир астрологии», «это не просто X, это Y»,
  «каждый из нас». Украинский/испанский/итальянский — аналогично.
- Персоны и стили сформулированы на английском с английскими культурными референсами
  (Target parking lot, Co-Star) — для ru/uk постов модель либо переводит кальку (звучит как
  перевод), либо игнорирует.

Это самая большая дыра в качестве не-английских постов: burstiness-инструкции модель
переносит между языками плохо, а слоп-словари у каждого языка свои.

**Фикс:** словарь `LANGUAGE_PACKS: Record<lang, { slopWords: string[], fewShotGood: string[],
fewShotBad: string[], culturalRefs: string }>` — инжектить в draft/critique/judge вместо
англоцентричных примеров. Для ru/uk достаточно 5-8 примеров и 15-20 слоп-фраз, чтобы качество
скакнуло. Judge должен получать slop-list соответствующего языка.

### 2.3 Юмор не операционализирован
Ресёрч (HumorGen 2026, arXiv 2405.20956): «be funny» не работает; работают **механики**.
У выигрышных шуток доминируют: incongruity/absurdity (>84%), позиция панчлайна в конце (96%),
краткость (72%). Провалы: generic punchline (69%), клише (65%), overexplained joke (22%).
Сейчас styles задают *формат* (hot take, meme, story), но не *механику юмора*.

**Фикс — добавить в draft-промпт слой HUMOR MECHANICS (ротировать 1 на пост):**
```
HUMOR MECHANIC for this post: {mechanic}
- misdirection: setup builds one expectation, last line breaks it. Punchline is the FINAL line. Never explain the joke after landing it.
- understatement: describe something cosmic/dramatic in deliberately flat, mundane terms ("Saturn return. Anyway, I repotted a plant.")
- hyperbole-deadpan: absurd exaggeration delivered with total seriousness, no exclamation marks.
- self-deprecation: the narrator is the punchline. Their chart called them out and they know it.
- absurd-specificity: one detail so oddly specific it becomes funny (not "cried" but "cried into a Trader Joe's tote").
- meta-irony: acknowledge you're an astrology account doing astrology-account things, wink, move on.
RULES: the joke lives in ONE line. If you explain it, delete the explanation. If the punchline isn't last, move it.
```
Это соответствует и вашему запросу (ирония/метаирония/постирония/сарказм — без оскорблений:
добавить строку «punch at planets, situations and the narrator — never at groups of people»).

### 2.4 Burstiness: заменить «vary rhythm» на структурную директиву
Ресёрч 2025-26 однозначен: расплывчатое «vary sentence length» модель выполняет плохо,
структурная директива — хорошо. Добавить в draft-промпт:
```
STRUCTURE: at least one sentence under 6 words. At least one over 20. Never two consecutive
sentences of similar length. NEVER use em dashes (—) — use periods, commas, parentheses.
```
Em dash — тел №1 у современных моделей (~8% предложений), в ваших banned-lists его нет.

### 2.5 Три расходящихся banned-list
Draft (graph.ts:667), critique (graph.ts:776), judge (judge-prompt.ts:27) — три списка, уже
разъехались (critique включает "discover/explore", judge — "powerful/profound/deeply", draft — оба
плюс фразы). **Фикс:** один `SLOP_LEXICON` (per-language, см. 2.2) в
`content-enhancements/slop-lexicon.ts`, из него собираются все три промпта + бесплатный
детерминированный скан (§5, F4).

### 2.6 Платформенные нюансы 2026 (EXA)
- **Threads:** короткие 1-2 предложения перформят лучше эссе; выигрывают «small confessions» и
  открытые вопросы; X-тон на Threads читается «холодным». Сейчас промпт говорит «Stay within
  500 chars» — модель заполняет лимит. Фикс: `target 150-280 chars, hard cap 500` + формат
  «наблюдение → незакрытый вопрос» (не engagement-bait, а вопрос, на который реально хочется
  ответить).
- **X:** одна мысль, панч, без объяснений — уже близко к текущему промпту. Добавить lowercase-
  вариант как стилевой приём (ротация): целиком lowercase пост — сильный «human» маркер.
- **Facebook:** ок, но «End with a genuine question» из NETWORK_TONE конфликтует с персоной
  Threads-стиля «never end with What do you think?» — уточнить: вопрос должен вытекать из
  истории, не быть приклеенным.
- `NETWORK_PERSONA.X` содержит «gets tired, cold, hungry, horny» — для бренд-аккаунта риск:
  модель может воспринять буквально. Убрать «horny», оставить телесность безопасной.

### 2.7 Судья должен решать, а не наблюдать
`judgeScores` пишутся в metadata и всё. Auto-approve смотрит только `qualityScore` критика.
**Фикс A (дёшево):** гейт auto-approve = `qualityScore >= 7 && judge.anti_ai_tone >= 0.6 &&
judge.factual_accuracy >= 0.5`.
**Фикс B (правильно):** conditional edge в графе: `judge → refine` (второй проход, max 1) при
`anti_ai_tone < 0.6`, иначе → visual_concept. LangGraph это делает штатно через
`addConditionalEdges`. Сейчас плохой пост никто не переписывает — его просто скорят и постят.

---

## §3. LangGraph / LangChain: корректность использования

Что сделано правильно (не трогать): Annotation-редьюсер для конкурентных апдейтов `results`,
per-network error isolation, `interrupt()`/`Command({resume})` для HITL, RedisCheckpointSaver с
`thread_id = runId:topic`, lazy-компиляция графа, AsyncLocalStorage для Langfuse-коллбеков —
это всё канонично.

Проблемы:

1. **Checkpoint-жир.** Полный state сериализуется на каждый superstep (~15+ узлов), и в state
   лежит `brandVoice` (~9KB — весь brand-voice.md). Это ×15 записей в Redis на каждый топик,
   бесполезный трафик и память. `brandVoice` — константа процесса: убрать из state, передавать
   через замыкание/`config.configurable`. Аналогично `topic.outline` можно не таскать после
   research_extract.
2. **Линейный конвейер вместо условного.** judge → visual → ab едут безусловно даже когда пост
   провальный (см. 2.7). `addConditionalEdges` отсутствует во всём графе — это главный
   неиспользованный инструмент LangGraph здесь.
3. **Structured output не используется.** Хуки парсятся split('\n'), скор — regex, judge — regex
   по `{...}`. LangChain `withStructuredOutput` / `response_format: json_object` поддерживается
   Groq/OpenAI/Gemini/DeepSeek; для остальных оставить regex-фоллбек. Меньше молчаливых потерь
   (сейчас невалидный JSON judge = просто нет скоров).
4. **`estimateTokens` = chars/4**, при том что `model.invoke()` возвращает
   `response.usage_metadata` с точными числами. `llmMetadata.tokens` в БД систематически врёт —
   для cost-аналитики бесполезен. Читать usage_metadata, при отсутствии — фоллбек на эвристику.
5. **Sticky-провайдер ломает консистентность голоса внутри рана.** `lastWorkingProvider`
   переключается посреди рана → 3 поста одного запуска могут быть написаны llama-70b, gemini и
   gpt-5-nano — три разных «человека» в одной ленте за один день. Фикс: пиновать провайдера на
   generation run (выбрать в начале, освобождать только при отказе).
6. **Prompt injection.** `sanitize-untrusted-input.ts` используется только в replies-monitor.
   Трендовые топики (скрейпятся из веба!) и контент CAP уходят в промпты сырыми. Топик вида
   `«ignore previous instructions...»` доедет до draft system prompt. Прогонять
   topic/keywords/facts через тот же санитайзер в research/hook/draft узлах.

---

## §4. Оптимизация использования LLM

### 4.1 Роутинг по ролям, а не одна цепочка на всё (главная оптимизация)
Сейчас все 6+ типов вызовов идут через одну free-first цепочку. Но задачи разные:

| Роль | Требование | Рекомендация |
|---|---|---|
| draft, hook | креатив, юмор, мультиязычность | сильная модель: claude-haiku / gemini-2.5-flash / deepseek-chat |
| critique, judge | следование рубрике, дёшево | groq llama-3.3-70b / gpt-5-nano |
| research_extract | фактология | gemini-2.5-flash (дёшево + знания) |
| thread-depth, visual, ab | утилитарные | самый дешёвый доступный |

Free-first для драфтов означает: качество самого важного вызова определяется тем, что Groq
сегодня не лежит. llama-3.3-70b на 2026 год — слабейший «комик» из вашего списка. Реализация
дешёвая: `LLM_ROLE_CHAINS` env (`draft=google,deepseek,groq;judge=groq,ollama;...`),
`generateChat(system, user, { role: 'draft' })` → цепочка фильтруется/переупорядочивается по
роли. Circuit breaker и кэш общие.

### 4.2 Concurrency-cap
3 топика × 3 сети × (draft|critique|refine|judge) + thread-depth/visual/ab при включении =
пики 9-15+ одновременных вызовов. Free-tier'ы (Groq 30 RPM, Gemini 15 RPM free) отвечают 429 →
цепочка падает каскадом → breaker флапает → всё уезжает в Ollama/gemma — худшую модель.
**Фикс:** семафор в LlmService (`LLM_MAX_CONCURRENT=4`, p-limit) + на 429 — один jittered retry
на том же провайдере прежде чем фейловер (429 — не повод менять провайдера, это повод подождать
2-5 сек).

### 4.3 Токен-диета
- §2.1 (brand-voice per-node) — минус ~40% input в draft/hook.
- hook_generation получает `facts.join(', ')` + весь brandVoice; хватает identity-абзаца.
- critique цитирует драфт целиком (нужно) + 10 пунктов рубрики — ок.
- Кэши уже хорошие (hook 30m / response 5m / Langfuse SDK 300s + CB + 3s timeout). Единственное:
  LLM-кэш ключуется на полный промпт — для t≥0.9 креативных вызовов кэш-хит = идентичные посты;
  сейчас спасает только короткий TTL. Креативные роли (draft/hook) лучше исключить из
  response-кэша вовсе (hook-кэш выше по стеку уже делает нужную дедупликацию).

### 4.4 Наблюдаемость качества
Langfuse уже подключён (трейсы, промпт-менеджмент — сделано аккуратно, с fallback и CB).
Не хватает: (a) score-репортинг в Langfuse — judge/critique скоры как `scores` на трейсе, чтобы
в UI фильтровать провальные генерации; (b) золотой датасет (F6 ниже).

---

## §5. Код и перформанс (вне LLM, кратко)

- **N+1 в generatePostsForTopic:** `accountsService.findByNetwork` зовётся в цикле по сетям и
  ПОВТОРНО после графа (service.ts:627, 706); `findBySourceAndNetwork` — последовательно.
  Загрузить аккаунты один раз на run (Map), проверки дедупа — `Promise.all`.
- **`loadRecentPostHashes(topic)` на каждый топик** — до 3 идентичных запросов в батче.
  Кэш на run.
- **SimHash-дедуп O(N)** по ~200 хэшам — сейчас норм; при росте — BK-tree/прекомпьютед bands.
- **generation.service.ts 1442 строки** — вытащить `PostPersister` (save+dedup+pillar+thread)
  и `RunLifecycle` (create/complete/fail + SSE) — три крупнейших метода это 60% файла.
- **Тестов на промпты нет** — юнитов много, но ни одного, который ловит регресс качества
  промптов (см. F6). Баг 1.1 (`includes('good')`) жил бы вечно: тесты мокают LLM и проверяют
  пайплайн, а не тексты.

---

## §6. Новые фичи (приоритезировано по эффекту на качество)

**F1. Creative Tournament (best-of-N).** Draft-узел генерит 2-3 кандидата параллельно — каждый
с другой humor-механикой (§2.3) и температурой (0.8/0.95/1.0 через отдельные инстансы, после
фикса 1.2). Judge выбирает победителя, остальные — в metadata для аналитики. Ресёрч
(HumorPlanSearch: +15.4% к humor-скору именно от плана-поиска+judge-отбора) и здравый смысл:
у юмора высокая дисперсия, один сэмпл = лотерея. Стоимость ×2-3 на draft-вызовы — компенсируется
ролевым роутингом (4.1) и тем, что draft — не самый дорогой узел.

**F2. Judge-gated refine loop** (§2.7B). Дёшево: одно условное ребро + счётчик в state.

**F3. Bit Bank — running gags.** Реальные аккаунты имеют повторяющиеся биты («the Target
parking lot», «мой асцендент опять что-то устроил»). Redis-хранилище: топ-фразы/шутки из
опубликованных постов с высоким engagement (у вас уже есть hook-performance-bank — расширить).
В 1 из ~7 постов инжектить в промпт: «Optionally call back to one of your running bits: {bits}».
Callbacks — сильнейший маркер живого автора, ни один AI-детектор их не «видит», а подписчики — да.

**F4. Deterministic Humanizer Gate** (0 токенов). По аналогии с bait-детектором: скан драфта —
sentence-length variance (burstiness), em-dash count, слоп-слова из per-language лексикона (§2.2),
хэштеги, «hook→explanation→CTA» паттерн (3 абзаца + вопрос в конце). Результат инжектится в
critique/refine как обязательные пункты. Дешёвый и детерминированный «пре-джадж».

**F5. Style Bandit.** Замена date-ротации стилей на Thompson sampling по накопленному
engagement (contentStyleId уже пишется в llmMetadata — данные есть). Дата-ротация даёт
равномерность, бандит — обучение тому, что заходит вашей аудитории per network.

**F6. Golden-set eval (`pnpm eval:prompts`).** 10-15 фиксированных топиков × 5 языков →
генерация → judge + humanizer-gate → отчёт (avg anti_ai_tone, slop-hits, burstiness).
Порог фейла. Гонять вручную/еженедельно и перед каждым изменением промптов; результаты — в
Langfuse datasets. Без этого любой тюнинг промптов — слепой.

**F7. Language packs** (§2.2) — few-shot + slop-lexicon + культурные референсы per язык.

**F8. Threads reply-first формат.** Отдельный шаблон «наблюдение + открытый вопрос» (не bait),
короткая длина (§2.6) — Threads-алгоритм 2026 взвешивает реплаи сильнее всего.

---

## §7. План внедрения

| Фаза | Что | Эффект/Усилие |
|---|---|---|
| P0 (день) | 1.1 critique-парс, 1.2 гонка temp, 1.3 review-edits, 1.4 заглушки, 2.6 persona «horny» | высокий / низкое |
| P1 (2-3 дня) | 2.1 переписать brand-voice.md + per-node инжект; 2.3 humor mechanics; 2.4 burstiness+em-dash; 2.5 единый слоп-лексикон; F4 humanizer gate; 1.7 judge-фиксы | очень высокий / среднее |
| P2 (неделя) | 4.1 ролевой роутинг (+Anthropic провайдер, 1.6); 4.2 семафор+429-retry; F7 language packs; 2.7/F2 judge-гейт | высокий / среднее |
| P3 | F1 tournament; F3 bit bank; F5 bandit; F6 golden-set; §3.1 checkpoint-диета; §5 рефакторинги | средний-высокий / высокое |

Метрика успеха: до/после по golden-set (F6): `judge.anti_ai_tone` avg ≥0.75 (сейчас неизвестно —
скоры не агрегируются), slop-hits = 0 на 5 языках, дисперсия длин предложений ≥ порога, и
человеческая проверка: 10 постов вслепую против 10 старых.

---

## §8. Статус внедрения (2026-07-05, quality pass — выполнено)

Реализовано в этом же проходе (P0+P1+P2 полностью):

| # | Правка | Где |
|---|---|---|
| 1.1 | Строгий парс `VERDICT: GOOD/REVISE` вместо `includes('good')` | graph refine + critique промпт |
| 1.2 | Гонка temp/maxTokens устранена — иммутабельные инстансы, ключ кэша `provider:model:t:m` | llm.service `getModelForProvider` |
| 1.3 | Review: показывается `refined`, правки пишутся в `refined` | graph `human_review` |
| 1.4 | Фоллбеки без слопа: хуки паддятся фактами deadpan, факты не добиваются мусором | graph hook/research |
| 1.5 | AB-варианты: только эмодзи, без «empowering»/CTA | ab-variant.generator |
| 1.6 | Anthropic-провайдер добавлен в цепочку (OpenAI-compat endpoint) | llm.service, .env.example |
| 1.7 | Judge: без enumeration-противоречия, maxTokens 300→700, получает facts + slop-list | judge-prompt, graph |
| 2.1 | brand-voice.md переписан — конфликты с анти-AI правилами убраны, ~50% короче | brand-voice.md |
| 2.2 | `slop-lexicon.ts` — единый мультиязычный словарь (en/ru/uk/es/it) во всех промптах | новый модуль |
| 2.3 | `humor-mechanics.ts` — 6 механик (misdirection/deadpan/метаирония...), ротация, punchline-last | новый модуль |
| 2.4 | Structural burstiness + бан длинных тире в draft/refine | graph промпты |
| 2.6 | Threads target 150-280, X lowercase-приём, persona без «horny» | graph |
| 2.7/F2 | Judge-gated refine loop: `anti_ai_tone < JUDGE_REFINE_THRESHOLD` → 1 ретрай через conditional edges | graph, env |
| F4 | `humanizer-gate.ts` — детерминированный скан (слоп/тире/burstiness/хэштеги), 0 токенов | новый модуль |
| F7 | `language-packs.ts` — нативные few-shot примеры ru/uk/es/it в draft-промпте | новый модуль |
| 4.1 | Per-role роутинг `LLM_ROLE_CHAINS` + creative-роли мимо response-кэша | llm.service |
| 4.2 | Семафор `LLM_MAX_CONCURRENT` + 429-ретрай на том же провайдере до фейловера | llm.service |
| §3.4 | Реальные `usage_metadata` токены вместо chars/4 | llm.service |
| §5 | N+1 по аккаунтам устранён (Map на топик), refine-fail больше не роняет пост | generation.service, graph |
| — | Бонус: pre-existing paramtypes-дрейф починен (TopicGenerationService, MetricsScraperService, SessionsService, голый ScheduleModule в content.module) | tests/*, content.module |

Тесты: **+37 новых юнитов** (slop-lexicon 9, humanizer-gate 7, humor-mechanics 6, llm-routing 8, quality-pass-graph 7). Итог прогона: юниты **1122/1122**, весь suite **1312 passed / 14 failed** (бейзлайн до правок: 1134 passed / 20 failed + 172 skipped из-за boot-failures). e2e-слой полностью зелёный — на бейзлайне лежал целиком.

Оставшиеся 14 падений — stale-ассерты в 6 старых файлах (top-down/acceptance/system), фиксировавшие мир ДО фич judge/ENABLED_NETWORKS/B5-dedup; эти файлы не бутались до починки paramtypes, поэтому дрейф копился незаметно. Причины по паттернам: (a) ожидают 3 сети при дефолте `ENABLED_NETWORKS=X,THREADS`; (b) ожидают 4 LLM-вызова без judge; (c) пара тестов ходит в dev-БД :5433. Чинится отдельным заходом — менять ассерты не глядя не стал.

Не реализовано (осознанно, P3): Creative Tournament (best-of-N), Bit Bank, Style Bandit, golden-set eval, checkpoint-диета. Также: если промпты уже загружены в Langfuse Prompt Management — их нужно перезалить (`scripts/migrate-prompts-to-langfuse.ts`), иначе продолжат компилироваться старые версии без slop-list/humor переменных.

---

### Приложение: источники ресёрча
- HumorGen / Cognitive Synergy (arXiv 2604.09629): персоны-механики + отбор кандидатов.
- HumorPlanSearch (arXiv 2508.11429): plan-search + judge-revision loop, +15.4% humor score.
- «A Robot Walks into a Bar» (arXiv 2405.20956, DeepMind): LLM даёт setup, панч — от механик; «bland/generic» — главный failure mode.
- Perplexity/burstiness guides 2025-26 (Postibo, IntellectualLead, NetusAI): структурные директивы > vague-инструкций; em-dash tell; prompt-level > post-hoc.
- Threads/X playbooks 2026 (Postory, PostEverywhere): Threads = короткие confession/question-посты, X-тон на Threads не работает; reply velocity решает.
