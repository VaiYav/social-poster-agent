# 02 — Bug Report

Конкретные баги с `file:line`, severity, impact, fix. Сгруппировано по модулям. Анти-бан/надёжность —
подробнее в `03`, безопасность — в `04`.

Пометка проверки: **[V]** — проверено первичным чтением исходника; **[S]** — найдено параллельным
deep-read субагентом (рекомендуется быстрый ре-чек перед фиксом).

---

## Posting / Browser / Queue

### P1. Детекция успеха постинга даёт ложные POSTED и ложные FAILED — **Critical** [V]
`base.poster.ts:155-225` (`validatePostOnProfile`), `x.poster.ts:222-253`

Проверка «опубликовалось ли» сводится к `pageText.includes(content.slice(0,40))` на странице профиля
и к «первая ссылка `/status/` на странице».
- **Ложный POSTED:** если сабмит провалился, но на профиле уже есть похожий/рециклнутый твит с теми
  же первыми 40 символами — валидация проходит, пост помечается POSTED со ссылкой на **старый** твит
  (`findTweetUrlOnPage` без фильтра по хэндлу берёт первую ссылку, `x.poster.ts:436-442`).
- **Ложный FAILED:** успешный пост, у которого `includes` не совпал (эмодзи/кириллица/реформат
  ссылок X), помечается FAILED → оператор ре-аппрувит → **дубль**.

**Fix:** дергать нативный permalink сразу после сабмита (из тоста/ответа), сверять по точному
тексту/нормализации, не по «первым 40 символам»; URL принимать только с совпадающим хэндлом.

### P2. `verifyPostVisible` / `detectPostShadowban` используют `networkidle`, которого на X/Threads нет — **High** [V]
`base.poster.ts:458, 507`

Собственный коммент (`base.poster.ts:163`) гласит: «X/Threads never reach networkidle due to
polling». Но обе пост-проверки делают `goto(postUrl, { waitUntil:'networkidle', timeout:15000 })` →
**всегда таймаут 15с** на X/Threads, затем `catch` → `false`. Верификация и шэдоубан-детекция на
X/Threads практически не работают (молча). То же в `replies-monitor.service.ts:216` (скрейп
комментов).

**Fix:** `domcontentloaded` + явный `waitForSelector` по контейнеру поста.

### P3. Ретрай/self-recovery вокруг неидемпотентного постинга → риск дубля — **High** [V]
`posting.service.ts:165-189` (мёртвый `withRetry`), `:204-274` (self-recovery повторяет `postFn()`)

Постеры не бросают → `withRetry` не срабатывает (мёртвый слой). Но self-recovery повторно вызывает
`postFn()` при тексте ошибки `/not logged in|session expired|relogin/i`. Если реальный сабмит прошёл,
а ошибка похожа на «relogin», будет повторная публикация. Нет «ровно один раз».

**Fix:** перед повтором — проверка, не появился ли пост (по permalink/timeline); идемпотентный ключ
на уровне доменной операции, а не только BullMQ `jobId`.

### P4. Идемпотентность `jobId=postId` поверхностна (живёт только пока job в Redis) — **Medium** [V]
`queue.factory.ts:88-107` (`removeOnComplete:{count:100}`)

`jobId=postId` дедупит только пока job не вытеснен (`removeOnComplete: 100`). После вытеснения
повторный `enqueuePosting(postId)` создаёт **новый** job. Реальную защиту от дубля даёт guard по
статусу POSTED/POSTING в `posting.service.ts:68-73` — но он же создаёт «orphaned POSTING» (см. `03`).
То есть настоящая идемпотентность держится на статусной машине, а не на очереди.

**Fix:** не полагаться на `jobId`; явная статусная машина + проверка факта публикации.

### P5. Facebook: единственный persistent-context, не пулится, `releaseContext` — no-op — **High** [V]
`browser.factory.ts:189-194, 231-233, 293-297`

Для FB `acquireContext` возвращает один общий persistent-context; `releaseContext` для FB ничего не
делает. Любые параллельные FB-операции (posting + replies + engagement) делят **один** контекст и его
страницы → гонки и интерференция страниц. Постинг сериализован очередью (concurrency=1 per network),
но replies/engagement идут своими путями параллельно постингу.

**Fix:** сериализовать все FB-операции (один воркер/мьютекс на FB-профиль), либо отдельные страницы с
явной координацией.

### P6. Пул контекстов не инвалидируется при пересоздании браузера — **Medium** [V]
`browser.factory.ts:78-105, 226-282`

`getBrowser()` пересоздаёт браузер при `!isConnected()`, но `idleContexts`/`inUseContexts` продолжают
держать контексты **мёртвого** браузера. После краша браузера `acquireContext` вернёт «живой» из пула
контекст, привязанный к закрытому браузеру → постинг падает до рестарта.

**Fix:** при пересоздании браузера чистить пул и ожидающих waiters.

### P7. `fullPage` скриншоты пишутся на диск без очистки — **High** [V]
`browser.factory.ts:500-518`; вызовы: `base.poster` (before-compose/after-type/after-submit/on-error/
after-validate), `base.engager.ts:117` (на **каждой** итерации скролла)

Каждый постинг = ~5 PNG `fullPage`; engagement-скролл = 120–300 PNG за сессию. Никто не удаляет.
`fullPage` на бесконечной ленте X — огромные файлы. `/tmp/spa-screenshots` и `/tmp/spa-profiles`
растут неограниченно → исчерпание диска → краш браузера/БД.

**Fix:** убрать per-scroll скриншоты (или за debug-флаг), ретенция/cleanup-cron, не `fullPage` для
лент.

### P8. `postAllApproved` и worker могут гонять один пост — **Low** [V]
`posting.service.ts:473-509`

`postAllApproved` дергает `postById` напрямую (вне очереди) с задержкой 10–30с. При одновременно
активном воркере оба берут пост; защищает только статус-guard. Лишний путь постинга в обход очереди.

**Fix:** единый путь постинга — только через очередь.

---

## Sessions / Auth

### SE1. Auto-login по username/password — самое «банабельное» действие, дергается на лету — **High** [V]
`sessions.service.ts:147-188, 330-470`

При истёкшей сессии во время постинга `getOrCreateSession` выполняет авто-логин формой
(username → password) прямо в момент публикации (`posting.service.ts:232`). Логин-автоматизация —
главный триггер «suspicious login»/челленджей (см. `03`/`05`). Cookie-путь есть, но при его провале —
форма-логин каждый раз.

**Fix:** не логиниться синхронно в постинге; выносить ре-логин в отдельный контролируемый процесс с
бэкоффом и алертом; приоритет cookie-auth, форму — крайний случай с длинным cooldown.

### SE2. Race на параллельный авто-логin — **Medium** [S]
`sessions.service.ts:96-160`

Несколько одновременных `getOrCreateSession` для одной сети могут одновременно стартовать авто-логин
(несколько форм-входов подряд → ещё более бот-подобно). Есть circuit breaker логина, но окно гонки до
него остаётся.

**Fix:** per-network мьютекс/инфлайт-промис на логин.

---

## Rate-limit

### R1. Engagement-лимиты молча режут лайки до 1/день, комменты до 1/день — **Critical** [V]
`rate-limit.service.ts:101-102,112`; вызовы `engagement.service.ts:110`,
`human-behavior-engine.ts:267,303,349,386`

Карты лимитов содержат только ключи `X|THREADS|FACEBOOK`. Engagement передаёт ключи вида `"X-like"`,
`"X-comment"` → `dailyLimits["X-like"]` = `undefined` → `?? 1`. После первого лайка дня `recordPost`
ставит счётчик=1, и каждый следующий лайк → `allowed:false`. Бюджеты `likesMaxPerSession=15` мертвы;
интервальный ключ блокирует 2-й лайк на 5 минут. Вся «человекоподобная» активность сводится к ~1
лайку/день.

**Fix:** отдельный `checkInteractionLimit(network, action)` со своими (interaction-size) дефолтами,
либо явные env-ключи `RATE_LIMIT_X-LIKE_*`. Передавать в постинге голую сеть.

### R2. `checkRateLimit` → `recordPost` неатомарны (TOCTOU) — **Medium** [V]
`rate-limit.service.ts:88-135, 141-165`

`check` делает `GET`, `record` — `INCR` позже, после многосекундного браузерного действия. Для
постинга смягчено сериализацией очереди (1 queue/network, concurrency=1), но engagement/replies/manual
API like идут мимо → лимит можно превысить. Коммент «Uses Redis INCR + EXPIRE for atomic…» вводит в
заблуждение: `check` не атомарен.

**Fix:** Lua-скрипт check-and-incr в один round-trip; интервальный ключ — там же.

---

## Engagement

### EN1. Каждый пост открывается отдельной навигацией → бот-сигнатура + сессия не укладывается в срок — **High** [S]
`human-behavior-engine.ts:115`, `base.engager.ts:318-327`, `x.engager.ts:21,42`

Для каждого поста движок `navigate()`-ит на отдельную страницу поста (3–8с), затем снова `navigate()`
для действия. 30 постов = 30–60 полных навигаций. Человек читает ленту инлайн. Это сильный
автоматизационный сигнал + сессия кратно превышает `durationSec`.

**Fix:** извлекать текст поста из DOM ленты при скролле; навигация — только при реальном действии.

### EN2. `performInteraction` течёт контекстом при ошибке — **Medium** [S]
`engagement.service.ts:159-224`

`createContext` (не пул) + закрытие `page/context` только на success-пути; в `catch` контекст **не
закрывается** (нет `finally`). Любой эксепшн энгейджера (а селекторы соцсетей падают часто) → утечка
контекста → исчерпание пула/памяти.

**Fix:** `try/finally` с гарантированным закрытием/релизом; выровнять с пуловым API.

### EN3. «Already liked» и follow рапортуются как успех → метрики и бюджет врут — **Medium** [S]
`x.engager.ts:33-36`, `threads.engager.ts:31-32`, `facebook.engager.ts:38-39`, `base.engager.ts:187-209,255`

`like()` возвращает `success:true`, даже если пост уже был лайкнут (лайк не делался) → `likesThisSession++`
и Interaction COMPLETED. `performFollow` **всегда** `true` без верификации.

**Fix:** различать «already-liked» и «performed»; верифицировать follow; не списывать бюджет за no-op.

### EN4. `visit-profile` извлекает хэндл регэкспом из URL → частые промахи — **Medium** [S]
`base.engager.ts:391-397`, `human-behavior-engine.ts:459-469`

Регэксп ловит `i/web/status/...`, `permalink.php?...`, `/groups/.../posts/...` → навигация на
`x.com/i` и т.п. (404, неестественный след).

**Fix:** брать хэндл автора из DOM поста, валидировать перед навигацией.

### EN5. `decideActionsBatch` — заморожённый снимок бюджета и риск превышения `maxTokens` — **Medium** [S]
`engagement-decision.service.ts:102-121`, `human-behavior-engine.ts:124,160`

Все контексты батча строятся с одним снимком `likesThisSession` → decision-layer бюджет-чек для батча
мёртв (ловит только рантайм-чек). `maxTokens: 200*len`; при парс-фейле весь батч деградирует в
`scroll` (а не пер-пост фолбэк, т.к. ошибка глотается, не бросается).

**Fix:** строить контексты по живым счётчикам; на парс-фейл — пер-пост fallback; ограничить maxTokens.

### EN6. `getStatus().pendingSessions` всегда 0; engagement останавливается после дня 1 — **High** [S]
`engagement-scheduler.service.ts:31,48-63,177`

Мёртвое поле `scheduledTimeouts` (миграция на BullMQ) → статус врёт. Нет полуночного крона →
`scheduleDailySessions()` зовётся раз на старте → после сегодняшних окон engagement не планируется.

**Fix:** удалить мёртвое поле; полуночный `@Cron` для пере-планирования; статус из BullMQ delayed-count.

---

## Replies

### RP1. Авто-reply блокирует крон `setTimeout`-ом 5–30 мин в последовательном цикле — **Critical** [S]
`replies-monitor.service.ts:117-134, 668-682`

`executeDecision` для `auto_reply` делает `await sleep(5–30мин)` **внутри** последовательного цикла по
комментам. Несколько авто-reply → цикл идёт часами, перекрывает следующий крон (каждые 4ч), нет
re-entrancy guard → два цикла параллельно скрейпят/отвечают на те же посты; рестарт во время сна
теряет reply.

**Fix:** ставить каждый авто-reply в BullMQ delayed job (`jobId=commentId`); крон возвращается быстро;
флаг `isRunning`.

### RP2. `commentId` из обрезанного `[^a-zA-Z0-9]` текста → кириллица коллапсирует — **High** [V (схема)] [S (логика)]
`replies-monitor.service.ts:271-274`; уник-ключ `schema.prisma:264` `@@unique([postId, commentId])`

`commentId = (author + text.slice(0,50)).replace(/[^a-zA-Z0-9]/g,'').slice(0,80)`. Для
кириллических/эмодзи комментов (основная аудитория) строка схлопывается почти в пустоту/в один
`author` → все комменты автора коллапсируют в один id, уникальный индекс дропает реальные комменты как
дубли.

**Fix:** брать нативный id/permalink комментария из DOM; не строить id из обрезанного текста.

### RP3. Чувствительные темы/жалобы НЕ проверяются на LLM-пути авто-reply — **High** (brand-safety) [S]
`replies-monitor.service.ts:393-398, 474-486, 508-528`

При `REPLIES_LLM_ENABLED=true` (дефолт) `decideReply` возвращает `llmDecideReply` и **не** запускает
детерминированные guards чувствительных тем/жалоб. Если LLM ошибётся на комменте про
горе/самоповреждение — бот ответит бодрым авто-reply без детерминированного бэкстопа.

**Fix:** жёсткий регэксп-прелфильтр чувствительных тем → принудительный `human_review` ДО и независимо
от LLM.

### RP4. Авто/ручной reply без идемпотентности → дубли — **Medium** [S]
`replies-monitor.service.ts:661-714, 741-782`

Нет условного перехода статуса; двойной клик/ретрай → два reply на один коммент.

**Fix:** условный `updateMany(where status=HUMAN_REVIEW → REPLYING)`, продолжать только при `count===1`.

### RP5. Скрейп комментов на `networkidle` (см. P2) + ре-скрейп каждого поста 6×/сутки — **Medium** [S]
`replies-monitor.service.ts:164-180, 216`

Нет `lastScrapeAt`-гейта: пост в 24ч-окне скрейпится ~6 раз (тяжёлая навигация), плюс `networkidle`
таймаут на X/Threads.

**Fix:** `domcontentloaded`+селектор; cooldown по `lastCommentScrapeAt`.

---

## Trending

### TR1. Хэндмейд-regex парсинг Google Trends RSS — **Medium** [S]
`trending-scraper.service.ts:251-282` — ломается на namespace/newlines/CDATA. **Fix:** `fast-xml-parser`.

### TR2. Селектор `[data-testid="trend"]` + `textContent.split('\n')[0]` берёт ярлык, не тренд — **Medium** [S]
`trending-scraper.service.ts:59, 347-362` — захватывает «Trending»/«Sports · Trending»; нет fallback-цепочки.

### TR3. `getMergedTrending` делает live-скрейп X на cache-miss, блокируя генерацию — **Medium** [S]
`trending-scraper.service.ts:505-577` — вопреки комменту «использует кэш»; сортировка по `priority`,
обещанный `rank` не используется (мёртвое намерение); дедуп по точной строке не мёржит cross-source.

---

## Recycling

### RC1. Endpoint `recyclePost` сломан — нет `@Param` — **Critical** [V]
`recycling.controller.ts:25-29` — `recyclePost(postId: string)` без `@Param('postId')` → `postId =
undefined` → `findUnique({ id: undefined })`. Роут не работает. **Fix:** `@Param('postId') postId`.

### RC2. Рециклинг никогда не запускается автоматически — **High** [V]
`recycling.module.ts` — нет крона/триггера; только ручной `POST /recycling/run`. **Fix:** weekly cron
или подключить в autonomy.

### RC3. Рецикл создаёт DRAFT = дословная копия, «перепишет генерация» — но никто не переписывает — **High** [S]
`recycling.service.ts:76-92` — `content: original.content`, комментарий «Will be re-written by
generation pipeline», но генерация идёт по топикам CAP, а не по DRAFT-постам. Если такой DRAFT
аппрувнуть — публикуется **дословный дубль** 30-дневной давности в обход SimHash. **Fix:** прогонять
оригинал через граф, либо запрещать аппрув без переписи.

### RC4. Несогласованный порог Hamming и порядок выборки — **Medium** [S]
`recycling.service.ts:29,45-50,127-135` — `loadRecentHashes` без `orderBy`; Hamming ≤5 здесь vs ≤3 в
генерации; кандидаты сортируются `postedAt desc` (рециклит «наименее старые»), без сигнала
производительности (вопреки заявленному «top performers»).

---

## Autonomy / Auto-approve / Content-enhancements

### AU1. Активный авто-аппрув обходит весь `AutoCheck` — **Critical** [V]
`auto-approve.listener.ts:58-105` — см. `01 A1`. Только `qualityScore`, без bait/char-limit/forbidden/
SimHash. **Fix:** единый gate через `AutoApproveService.evaluate()`.

### AU2. Авто-аппрув fail-open при отсутствии score — **Critical** [V]
`auto-approve.listener.ts:77-81` — нет score → approve («backward compat»). **Fix:** fail-closed → DRAFT.

### AU3. Двойной enqueue/расхождение решений при обоих флагах — **High** [V]
`auto-approve.listener.ts:58` + `autonomous-runner.service.ts:116-135` — listener и runner обрабатывают
один пост; разные решения по `Post.status`. **Fix:** один владелец решения.

### AU4. `AUTONOMOUS_TARGET_NETWORKS` без валидации значений — **Medium** [S]
`autonomous-runner.service.ts:49-50` — CSV кастуется в `SocialNetwork[]`; опечатка `THREDS` →
очередь `spa-posting-threds`, которая никогда не разгребается. **Fix:** валидировать против enum.

### AU5. Trend-guardrail Layer-2 fail-open + prompt-injection — **High** [S]
`trend-guardrail.ts:128,156-169` — на ошибке LLM/JSON возвращает `{safe:true, opportunityScore:5}`;
сырой `topic` интерполируется в промпт. Brand-safety-фильтр должен fail-closed. **Fix:** на ошибку →
`safe:false`/human-review; делимитировать недоверенный ввод. (см. `04`)

### AU6. Blocklist по `includes` ловит подстроки — **Low** [S]
`trend-guardrail.ts:92-95` — `war`/`dead`/`affair` матчат «forward»/«deadline»/«affairs». **Fix:**
`\bword\b`.

### AU7. A/B «Variant A» emoji-strip портит контент; `countEmojis` ≠ strip-диапазон — **Medium** [S]
`ab-variant.generator.ts:199-204, 243` — жадный `\s*…\s*` коллапсит пробелы вокруг матчей;
метаданные emojiCount несогласованы. **Fix:** точный emoji-матчер, юнит-тест на сохранность ASCII.

### AU8. Thread-continuations без проверки char-limit — **Medium** [S]
`thread-depth.controller.ts:187-236` — промпт «<280» не валидируется; `heuristicContinuations` пушит
сырые `keyFacts[i]` >280 → X режет/ломает тред. **Fix:** валидировать/резать каждую continuation.

---

## Posts / API

### PO1. `approve()`/`reject()` без валидации перехода состояний — **High** [S]
`posts.service.ts:123-145`, `posts.controller.ts:128-154` — POSTED/FAILED/REJECTED/POSTING можно
ре-аппрувнуть и заэнкьюить; FAILED → ре-постинг, REJECTED воскрешается. **Fix:** 409, если
`status !== DRAFT`.

### PO2. Отредактированный контент не валидируется по char-limit на бэкенде — **Medium** [S]
`posts.service.ts:131-134` — `editedContent` сохраняется без проверки длины; `POST /posts/:id/approve`
с сырым телом обходит UI-лимиты → 600-символьный X-пост упадёт при постинге. **Fix:** серверная
проверка `NETWORK_LIMITS[network]`.

### PO3. `approve` маскирует реальную ошибку под 404 — **Medium** [S]
`posts.controller.ts:150-153` — любая не-BadRequest ошибка → `NotFoundException`. DB-сбой выглядит как
«не найдено». **Fix:** маппить в 404 только `P2025`/NotFound.

### PO4. Пагинация делит на `query.limit` (риск /0) — **Low** [S]
`posts.service.ts:45` — `limit=0` → `Infinity/NaN`. **Fix:** Zod `min(1)`.

---

## Analytics / Accounts

### AN1. `metrics-scraper` — вечная заглушка `return null` — **Medium** [S]
`metrics-scraper.service.ts:147-171` — `PostMetrics` не наполняется → hook-bank «учится» вхолостую,
но логирует «collected: N». **Fix:** реализовать скрейп или явно отключить engagement-веса флагом.

### AN2. Дневная статистика по `createdAt`, не `postedAt` — **Low** [S]
`analytics.service.ts:82-114` — пост создан в Пн, опубликован в Чт → попадает в Пн; оси
summary/chart несогласованы.

### AN3. `seedFromEnv` матчит по `(network, handle)` → смена хэндла плодит дубль аккаунта — **Low** [S]
`accounts.service.ts:66-76`; `getCredentials` без `default` (`:104-123`) → `undefined` при новом enum.

---

## Quote-cards

### QC1. Satori вызывается с `fonts: []` → фича всегда падает — **High** [S]
`quote-card.service.ts:99-104,124` — Satori требует хотя бы один шрифт-буфер, иначе бросает; всегда
catch → `null`, контроллер 500. **Fix:** грузить реальный `.ttf`. (Проверить рендером перед фиксом.)

### QC2. Возврат `Buffer` через `@Res({passthrough:true})` — хрупкая сериализация — **Low** [S]
`quote-card.controller.ts:36-39` — файл пишется на диск и тут же читается; `res.send(buffer)` надёжнее.

---

## UI

### UI1. `PostCard.displayContent` — не реактивный `const` — **Medium** [S]
`PostCard.vue:23-27` — вычислен один раз; SSE/правки контента не ре-рендерятся, карточка показывает
устаревший текст. **Fix:** `computed()`.

### UI2. Оптимистичный `approve` без подтверждения (нет SSE `post_approved`) — **Medium** [S]
`stores/posts.ts:54-78`, `sse.service.ts` — бэкенд не шлёт событие на approve; драфт исчезает без
подтверждения; rollback пушит в конец списка (ре-ордер/дубль). **Fix:** событие `post_approved` +
ре-вставка по индексу.

### UI3. SSE backpressure: утечка `drain`-листенеров и таймеров — **Medium** [S]
`sse.service.ts:80-95` — на каждый медленный `write` регистрируется новый `once('drain')` + `setTimeout(5s)`
без дедупа → накопление таймеров/листенеров под нагрузкой. **Fix:** один `draining`-флаг на клиента.

### UI4. SSE `connected`-кадр попадает в ленту мониторинга на каждом реконнекте — **Low** [S]
`useSSE.ts:81-87`, `sse.service.ts:55` — `onmessage` парсит heartbeat `{type:'connected'}` как событие.
**Fix:** фильтровать `type==='connected'`.

### UI5. `generating` может залипнуть навсегда — **Low** [S]
`views/Generate.vue:88-102` — флаг сбрасывается только по SSE `generation_completed/failed`; пропуск
события (обрыв) → кнопка «Generating…» навсегда. **Fix:** сбрасывать по таймауту/HTTP-ответу.

### UI6. `recycle()`/`pauseRun()`/`resumeRun()` мимо общего axios — **Low** [S]
`views/Generate.vue:125-153` — сырой `fetch` без таймаута/интерсептора/correlation-id. **Fix:** через
`useApi()`.

### UI7. Тосты на каждый SSE-error → спам при реконнект-шторме — **Low** [S]
`App.vue:42-44`, `useSSE.ts:77` — до 50 тостов. **Fix:** дебаунс/только терминальный фейл.

---

## Сводка по приоритету

**Critical:** P1, R1, RC1, AU1, AU2, RP1 (+ безопасность из `04`: XFF, FB plaintext cookies).
**High:** P2, P3, P5, P7, SE1, EN1, EN6, RP2, RP3, RC2, RC3, AU3, AU5, PO1, QC1, B5(`01`).
**Medium и ниже:** остальное.
