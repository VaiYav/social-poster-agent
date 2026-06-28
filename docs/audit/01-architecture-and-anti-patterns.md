# 01 — Архитектура: ошибки проектирования и анти-паттерны

Только проблемы. Привязка к `file:line`. Severity по легенде из `00-OVERVIEW.md`.

---

## A. Ошибки проектирования

### A1. Два независимых конвейера принятия решения о публикации — **Critical**
`events/listeners/auto-approve.listener.ts:58-105` vs `modules/autonomy/auto-approve.service.ts:61-100`

Решение «публиковать ли пост без человека» принимается в двух местах с разной логикой:

- `AutoApproveListener` (подключён в `EventsEdaModule`, срабатывает на каждый `DRAFT_GENERATED`) —
  проверяет **только** `qualityScore >= minScore`.
- `AutoApproveService.evaluate()` (вызывается **только** из `AutonomousRunnerService`) — прогоняет
  полный `AutoCheck` (engagement-bait, char-limit, forbidden phrases, SimHash) + quality.

Активный на практике путь (listener) обходит весь `AutoCheck`. Хуже: при обоих включённых флагах
(`AUTO_APPROVE_ENABLED` + `AUTONOMOUS_RUNNER_ENABLED`) один и тот же пост обрабатывается обоими путями
→ гонка по `Post.status` (listener APPROVED по score 7, evaluate REJECTED по проваленному AutoCheck).
И они **по-разному** трактуют отсутствие score: listener — fail-open (approve), evaluate — `?? 0` →
REJECT, а сам `AutoCheck` пропускает quality-проверку при `undefined`. Три компонента не согласованы.

**Fix:** один владелец решения. Listener должен вызывать `AutoApproveService.evaluate()` (единый
gate, всегда `AutoCheck`), либо удалить один из путей. Политику «нет score» определить один раз и
сделать **fail-closed** (оставлять DRAFT).

### A2. Feature-flag gating через сырой `process.env` на этапе загрузки модуля — **High**
`app.module.ts:46-58`

Флаги читаются напрямую из `process.env` при конструировании `@Module` (до `validateEnv()` в
`onModuleInit`), и только в форме `=== 'true'`. Последствия:

- `ENGAGEMENT_ENABLED=TRUE` / `1` / `yes` → молча **выключено**. Тот же баг повторяется во многих
  сервисах (`auto-approve.service.ts:46`, `autonomous-runner.service.ts:43`, `quote-card.service.ts:23`,
  `ab-variant.generator.ts:70`, `visual-concept.service.ts:75`).
- Переключение флага требует **рестарта** (модуль либо в `imports`, либо нет).
- Когда модуль выключен, его сервисы **физически отсутствуют** в DI → попытка резолва падает, роуты
  404. Это «всё-или-ничего», не «disabled».

**Fix:** один помощник `parseBool()` (truthy-формы или строгая Joi-валидация с предупреждением);
рантайм-флаги через `FlowControlService`/Redis там, где нужен тогл без рестарта.

### A3. Гексагональная граница протекает — **Medium**
`x.poster.ts:489` (`process.env.SOCIAL_X_USERNAME`), `posters/*` импортируют типы `playwright-core`
напрямую (`base.poster.ts:9`), множество сервисов читают `process.env.*` вместо `ConfigService`.

Порт `IBrowserPort` существует, но доменный слой постеров завязан на конкретный `playwright-core`
(`Page`, `Locator`, `BrowserContext`) — заменить адаптер на не-Playwright (официальный API, другой
драйвер) невозможно без переписывания постеров. `x.poster` лезет в env за хэндлом аккаунта, минуя
`AccountsService`/`ConfigService`. ADR-004 называет порт `IContentSourcePort`, в коде —
`IContentPort`; `IEngagementDecisionPort` в ADR отсутствует. Граница есть на словах, но протекает.

**Fix:** постеры должны принимать узкий доменный интерфейс страницы (или вообще `PostCommand` →
адаптер), а не типы Playwright; хэндл/креды — только через порт аккаунтов.

### A4. LangGraph-граф — не источник истины; персистентность и dedup снаружи — **Medium**
`generation.graph.ts` (узел `save_to_db` только форматирует state), `generation.service.ts:525-571`

Узел `save_to_db` — мисномер: он не пишет в БД. Реальная запись Post + SimHash-dedup (Hamming ≤3)
происходит в `GenerationService` **после** `graph.invoke()`. Значит: граф можно «успешно» выполнить,
а пост — не сохраниться/отсеяться; crash-resume через `RedisCheckpointSaver` восстановит узлы графа,
но не доменную транзакцию. JSDoc чекпойнтера про ключ `thread_id` неверен (`runId` vs
`${runId}:${topic}`). Источник истины размазан между графом, сервисом и чекпойнтером.

**Дополнительно (потенциальный дубль):** dedup сверяет кандидата с **снимком** недавних хэшей из БД,
но при параллельной генерации трёх сетей в одном run (`Promise.allSettled`, `:219`) сиблинги **не
сверяются между собой** → почти-дубли по трём сетям в одном прогоне могут пройти все. Проверить и
добавить in-run дедуп.

### A5. Циклическая зависимость «залатана» ленивым `ModuleRef`, а не разорвана — **Medium**
`auto-approve.listener.ts:107-122`, `posts.controller` (тот же паттерн)

`PostsModule → QueueModule → PostingModule → PostsModule` — цикл. Вместо выделения порта очереди его
обходят `await import(...)` + `moduleRef.get(QueueService, {strict:false})`. Это прячет цикл от
компилятора, но: резолв может вернуть `undefined` (тогда «enqueued but not» — полагается на
reconciliation), и типобезопасность теряется. Архитектурный цикл остаётся.

**Fix:** ввести `IPostingQueuePort` (Symbol) в доменном слое, биндить в инфраструктуре — цикл
исчезает без `ModuleRef`-хака.

### A6. God-объекты — **Medium**
`sessions.service.ts` (1287), `generation.service.ts` (1254), `replies-monitor.service.ts` (797),
`browser.factory.ts` (618), `trending-scraper.service.ts` (608)

Эти файлы совмещают по 4–6 ответственностей (sessions: auto-login per network + cookie-parsing +
шифрование + circuit breaker + warm-up взаимодействие; generation: 3 разных пайплайна + brand-voice +
threads + dedup + SSE). Тестируемость и изоляция изменений страдают; именно здесь концентрируются
баги из `02`/`03`.

**Fix:** выделить per-network login-стратегии (strategy pattern), вынести cookie-parsing и
dedup в отдельные сервисы.

### A7. Три параллельные системы событий без единого доменного лога — **Low/Medium**
`events/` (EventEmitter2 внутр. шина), `infrastructure/sse/sse.service.ts` (Redis pub/sub → EventSource),
плюс BullMQ-события.

SSE — односторонняя, EventEmitter2 — внутренняя, BullMQ — своя. Нет единого журнала
post-lifecycle. Практическое следствие: **нет события `post_approved`** в SSE, из-за чего UI
оптимистично удаляет драфт и не получает подтверждения (`05`/`02 F33`). `GenerationService` вообще
не эмитит SSE — прогресс генерации не виден в UI.

---

## B. Анти-паттерны реализации

### B1. Слой `withRetry` вокруг постинга — мёртвый, а реальный ретрай неидемпотентен — **High**
`posting.service.ts:165-189` vs `x.poster.ts:288-295`

Постеры **никогда не бросают** — внутренний `try/catch` возвращает `{ error }`. Значит обёртка
`withRetry(postFn, { retryable: … })` в `posting.service` никогда не срабатывает (нет throw) — это
мёртвый код. При этом self-recovery (`:204-274`) повторно вызывает `postFn()` после «session
expired», а вокруг постинга нет идемпотентности → при неточной детекции успеха возможен **дубль
поста**. Архитектурно: ретрай прикручен не туда.

### B2. Сквозное проглатывание ошибок — **Medium**
`posting.service.ts:413`, постеры `withErrorHandling`, десятки `.catch(() => {})`,
`accounts.service.ts:29-36` (`catch { warn('continuing') }` без `err`).

Ошибки массово конвертируются в «мягкие» значения/логи без типа и контекста. Диагностика
продакшн-инцидентов затруднена: причина теряется (например, ошибка Prisma в `approve` маппится в 404,
`posts.controller.ts:150-153`).

### B3. `estimateTokens = length/4` и cache-key без `maxTokens` — **Low**
`llm.service.ts:265-267, 316-326`

Оценка токенов по длине неверна для кириллицы (целевая аудитория RU/UA), поэтому трекинг
стоимости/лимитов смещён. Ключ кэша хэширует только `system||user||temp`, без `maxTokens` и прочих
опций → коллизии между вызовами, отличающимися лимитом вывода.

### B4. Чтение runtime-данных из `process.cwd()` — **Medium**
`generation.service.ts:758` (`brand-voice.md`), `content-reader.ts` (CAP `runs/*` из `../`).

`brand-voice.md` и контент CAP читаются относительно текущей рабочей директории на рантайме. Запуск
из другой cwd (CLI, cron, контейнер с иным workdir) молча даёт «brand-voice.md not found → minimal
guidelines» и пустой контент. Поведение зависит от того, откуда стартовали процесс.

### B5. `uncaughtException` глушится, `unhandledRejection` не обрабатывается — **High**
`main.ts:10-17`

Любой uncaught-эксепшн логируется, но процесс **не завершается** — Node продолжает в неопределённом
состоянии (БД/браузер/очередь могли остаться в полусломанном виде). Глобального
`unhandledRejection`-хендлера нет вовсе. Это анти-паттерн: после uncaughtException корректно —
graceful shutdown, а не «продолжаем как будто ничего».

### B6. Ручная env-валидация мутирует `process.env` — **Low (с обоснованием)**
`env.validation.ts:131-162`

`validateEnv()` копирует Joi-дефолты обратно в `process.env`. Это сознательный обход
`ConfigModule.validationSchema` (иначе ломаются тесты, выставляющие env после импорта). Решение
оправдано, но хрупкое: порядок «feature-flags читаются в `app.module` ДО `validateEnv`» означает, что
флаги не видят дефолтов Joi (см. A2). Не «чинить» наивно — но задокументировать инвариант и убрать
двойное чтение флагов.

---

## C. Мёртвый и противоречивый код

| # | Где | Проблема | Severity |
|---|-----|----------|----------|
| C1 | `replies.service.ts:71-115` | `RepliesService.decideReply` — заглушка-плейсхолдер, но подключена и экспортируется параллельно реальному `RepliesMonitorService`; два типа `ReplyDecision` с разной формой; reply-состояние пишется в `post.llmMetadata.replies`, а монитор читает таблицу `IncomingComment` | Medium |
| C2 | `engagement-scheduler.service.ts:31,66-70,177` | `scheduledTimeouts` — мёртвое поле после миграции на BullMQ; `getStatus().pendingSessions` всегда 0 | Medium |
| C3 | `metrics-scraper.service.ts:147-171` | `scrapePostMetrics` всегда `return null` (TODO) → `PostMetrics` никогда не наполняется → «обучение на engagement» (`hook-performance-bank`) работает вхолостую, но логирует «collected: N» | Medium |
| C4 | `recycling.module.ts` | Нет крона/триггера — рециклинг запускается только вручную через endpoint (который к тому же сломан, см. `02`) | High |
| C5 | `engagement-scheduler.service.ts:48-63` | `scheduleDailySessions()` вызывается один раз на старте; нет полуночного крона → после последнего окна сегодня engagement больше не планируется до рестарта | High |
| C6 | `visual-concept.service.ts:105` | `content.length % 5` назван «content hash» — не хэш, ломает заявленную вариативность градиентов | Low |
| C7 | `trend-guardrail.ts:84-85` | `path.startsWith('trending/') || path.includes('trending/')` — первое условие — подмножество второго (мёртвое) | Low |

---

## D. Тестирование

### D1. Зелёный CI ≠ рабочий постинг — **High**
Браузерная автоматизация замокана во всех тестах; ни один тест не гоняет реальные селекторы
X/Threads/Facebook. Самый хрупкий и важный слой (DOM соцсетей) не покрыт end-to-end. Единственная
реальная проверка — ручной `pnpm dry-run`. Регрессии селекторов CI не ловит.

### D2. Vitest single-thread + мутация глобального `process.env` — **Medium**
`poolOptions.threads.singleThread=true`, `tests/setup.ts` мутирует `process.env`. Тесты **не
изолированы** между собой; порядок и утечки env влияют на результат. Любой тест, меняющий env,
способен «заразить» соседние.

### D3. esbuild стирает DI-метаданные → ручное восстановление paramtypes — **Medium**
`tests/helpers/sprint-o-paramtypes.ts`. Vitest трансформирует esbuild-ом, который не эмитит
`design:paramtypes`, поэтому Nest резолвит class-typed конструкторные параметры в `undefined` (живёт
только `@Inject(TOKEN)`). Все full-AppModule тесты вручную восстанавливают метаданные. **Добавление
инжектируемого/смена сигнатуры конструктора ломает full-app тесты** — скрытая связанность тестов с
конструкторами.

### D4. Цифры покрытия/тестов в доках расходятся — **Low**
ROADMAP называет 458/375/368… — реальное число только прогоном. Метрики в прозе не доверять.

---

## E. Итоговые рекомендации по архитектуре

1. **Свести решение о публикации в один gate** (A1) — самый высокий приоритет: это про безопасность
   контента, а не про стиль.
2. **Ввести порт очереди и порт «страницы/постинга»** (A3, A5) — разрывает цикл и изолирует постеры
   от Playwright (тестируемость, мок, возможная смена браузерного драйвера), не завязывая домен на
   конкретный движок. Постинг остаётся stealth.
3. **Единый `parseBool` + рантайм-флаги** (A2) — убирает класс «молча выключено».
4. **Вынести персистентность/дедуп в явную транзакцию**, не размазывать вокруг графа (A4).
5. **Разнести god-объекты** (A6) — снизит плотность багов в sessions/generation/replies.
6. **Graceful shutdown на uncaughtException + handler на unhandledRejection** (B5).
7. **E2E-смоук против реальных DOM** (хотя бы dry-run в CI на nightly) — иначе CI не защищает от
   главного риска (D1).
