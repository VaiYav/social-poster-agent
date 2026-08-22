# ROADMAP V2 — от автопостера к лид-машине

> **Версия:** 2.0 · **Дата:** 2026-08-22 · **Статус:** ACTIVE
> Заменяет `ROADMAP.md` (фазы 0–6, sprints A–G — завершены, см. §8 Карта архива).
>
> Продукт: автономный агент ведения соцсетей (X / Threads / Facebook + синдикация), генерирующий,
> публикующий и продвигающий контент. Главная метрика успеха — **атрибутируемые лиды** в продукт
> [my_zodiac_ai](https://github.com/valentinyakovlev/my_zodiac_ai), а не «посты опубликованы».

---

## Legend

| Метка | Значение |
|---|---|
| **Z1–Z6** | Зоны ответственности (§2). Каждая задача привязана к одной зоне |
| **M0…M6** | Фазы роадмапа (§4). Фазы частично перекрываются |
| **GATE** | Измеримый критерий закрытия фазы. Пока GATE не пройден, следующая фаза не стартует |
| **R1…R8** | Пункты рефактор-реестра (§6) |
| **P1/P2/P3** | Приоритет внутри фазы (must / should / nice-to-have) |
| *(NN)* | Ссылка на proposal из `docs/roadmap/01..07` или на другой док |

---

## §1 Цели и KPI

### Цель 1 — Привлечение лидов (PRIMARY)

Соцсети → клики → квиз-воронка `quiz.my-zodiac-ai.com` → подписки/оплата.
Вся атрибуция живёт в `my_zodiac_ai/back` (модуль `attribution-links`, Wave #213):
click → quiz session → snapshot → подписка, со сквозным stitch-key `quizSessionId`
и записью конверсии (`convertedAt/revenue/subscriptionId`) обратно в клик.

| KPI | Как меряем | Базлайн |
|---|---|---|
| Посты с трекабельной ссылкой | `%` постов с `ctaUrl != null` | 0% (промпты запрещают URL) |
| CTR ссылок | клики / показы по данным funnel-отчётов | — |
| Лиды в неделю | `AttributionClick` → signup по campaign=`social-agent` | 0 |
| Конверсии / выручка | `GET :id/funnel` → revenue по линкам агента | 0 |

### Цель 2 — Узнаваемость бренда

| KPI | Как меряем |
|---|---|
| Рост подписчиков | дельта по аккаунтам за 30д (PostMetrics + профили) |
| Impressions / engagement rate | PostMetrics (likes/comments/shares/impressions), скрапинг уже есть |
| Стабильность присутствия | % дней с ≥1 публикацией на сеть (orchestrator health) |

### Цель 3 — Качественная агентская система

| KPI | Как меряем |
|---|---|
| Uptime автономного цикла | ≥99% за 30 дней (watchdog + self-healing) |
| Доля действий без оператора | orchestrator actions / ручные вмешательства |
| Стоимость на пост | токен-телеметрия Langfuse, $/пост, тренд вниз |
| Качество контента | judgeScores (anti_ai_tone ≥0.7) + корреляция с решениями оператора |

---

## §2 Зоны ответственности

Работа разбита на 6 зон. Зона = «кто владеет проблемой», а не директория кода.

### Z1 — Orchestrator & Reliability
Автономный цикл OBSERVE→DECIDE→ACT как единственный путь выполнения.
13 action handlers, adaptive sleep, watchdog (`*/5 * * * *`). Завершение work streams
из `.forge/orchestrator/TASKS.md` (WS-1..WS-8), self-healing *(06)*, GA-переключение
(`ORCHESTRATOR_ENABLED=true` default, 11 кронов не регистрируются), удаление dual-path.
Владелец GATE'а: uptime ≥99%.

### Z2 — Content Intelligence
Промпты и качество генерации: research → hooks → draft → critique → refine → judge
(Langfuse Prompt Management, 7 промптов). CTA-политика (снятие запрета URL),
per-account brand voice *(04)*, fact-checking пайплайн (дифференциатор — никто из
конкурентов Postiz/Mixpost/Typefully/Hypefury/Buffer/Publer/Taplio этого не делает),
hook bank → few-shot обратная связь.

### Z3 — Accounts & Networks
Мультиаккаунтность *(01)*: per-account выбор вместо `findByNetwork()` → первый активный;
изоляция сессий/браузерных контекстов/лимитов/warmup per account. Per-account настройки *(02)*.
Синдикация end-to-end (article-graph: Dev.to/Hashnode/LinkedIn long-form + реальный
`verifyCanonical()`). Валидация новых сетей (FB battle-test, Bluesky/Mastodon/Telegram).
Капабилити постеров: `postWithReplyLink()` для X/Threads. Image gen *(03)*.
Масштабирование публикаций на N ресурсов — PublisherRegistry + fan-out, правило
выбора транспорта (free API → API, иначе stealth browser) и таблица кандидатов: §9.

### Z4 — Link Attribution (клиент zodiac-back)
**Интеграционная зона.** Своя инфраструктура ссылок НЕ строится — редиректы, клики,
конверсии и revenue живут в `my_zodiac_ai/back` (`modules/business/attribution-links`).

Поток атрибуции:

```
Генерация поста
   │ ZodiacLinkClient.createTrackableLink({network, campaign, postId})
   │ POST {ZODIAC_API_URL}/internal/attribution-links   (X-Internal-Token)
   ▼
my_zodiac_ai/back · attribution-links
   │ slug → shortUrl https://quiz.my-zodiac-ai.com/r/{slug}
   ▼
Post.ctaUrl = shortUrl → постер публикует (X/Threads: линк в первом ответе)
   ▼
клик → /r/[slug] → resolveForRedirect() → AttributionClick (geo/device/ipHash)
      → 302 на destinationUrl + utm_* → квиз → signup → payment → конверсия пишется в клик
   ▼
дашборд social-poster ◄── GET /internal/attribution-links/:id/funnel (клики→конверсии→revenue)
```

Ответственности social-poster:
- `ILinkPort`: `createTrackableLink()` / `getFunnelReport()` / `buildDirectUtmUrl()` (fallback)
- Маппинг `Post ↔ attributionLinkId/slug` в Prisma
- Fallback при недоступности zodiac: прямой UTM-линк (ядро — оживлённый `source-url.util.ts`)
- Дашборд: агрегация funnel-отчётов по кампаниям/сетям

Контракт zodiac-back (уже реализован, Wave #213):
`AttributionLink{slug, platform(=utm_source), medium(default social), campaign, content,
refTag, customFields(post_id...), destinationUrl(allowlist *.my-zodiac-ai.com)}`
+ `AttributionClick` (per-click, geo/os/browser, stitch-key `quizSessionId`, TTL 30д,
конверсия-writeback). Admin API `/api/v2/admin/attribution-links` существует; для
сервис-сервис доступа добавляется тонкий `/internal/attribution-links` под существующим
паттерном `MAIN_BACKEND_INTERNAL_TOKEN`.

Env: `ZODIAC_API_URL`, `ZODIAC_INTERNAL_TOKEN`,
`ZODIAC_DEFAULT_DESTINATION_URL` (default `https://quiz.my-zodiac-ai.com`).

### Z5 — Analytics & Learning
Дашборды (Next.js UI): conversion dashboard v1, judge calibration, best-time-to-post.
A/B на масштабе: `PostVariant` (инфраструктура описана в `docs/features/ab-testing-infrastructure.md`)
→ метрики → авто-выбор победителя → фидбек в hook bank. Posting windows из реальных PostMetrics.

### Z6 — Platform Health
Tech Radar (§5): апгрейды LangGraph 0.2→1.x, Zod 3→4, аудит playwright-core patch sites.
Рефактор-реестр (§6). Консолидация planning-доков (§8). Token cost optimization *(05)*.
ResilienceService скелет *(06)*.

---

## §3 Снапшот текущего состояния (август 2026)

**Что работает:**
- Генерация: LangGraph-граф research→hooks→draft→critique→refine→judge→visual_concept;
  чекпоинты Redis, resume после падений; LLM-as-a-Judge (anti_ai_tone / hook_strength /
  factual_accuracy / character_limit) в `judgeScores`
- Промпты в Langfuse Prompt Management (7 шт., версионирование, circuit breaker, inline fallbacks)
- Постинг: X / Threads / Facebook через Camoufox (patched playwright-core), verifyPosted(),
  resource blocking в read-only контекстах, memory prefs
- Orchestrator: 13 action handlers, HardRules H1-H10 → LLM → Guardrails G1-G7, heartbeat,
  watchdog `*/5`; кроны отключаются при `ORCHESTRATOR_ENABLED=true` (dynamic registration)
- Метрики: PostMetrics (likes/comments/shares/impressions), trending scraper, hook performance bank
- Наблюдаемость: Sentry + Langfuse (traces, judgeScores в llmMetadata)

**Чего нет (и почему это главный пробел):**
- **Ноль исходящих ссылок**: промпты запрещают URL (fallback-prompts.ts, generation.service.ts);
  `source-url.util.ts` — мёртвый код (P10); `CanonicalUrlService` — только POSSE SEO,
  `verifyCanonical()` заглушка ⇒ **лиды не измеряются вообще**
- Мультиаккаунт: схема готова (`SocialAccount @@unique(network,handle)`), но выбор всегда
  «первый активный» — нет изоляции лимитов/сессий/warmup
- Engagement (~1300 строк) заморожен за `ENGAGEMENT_ENABLED`; Replies за `REPLIES_ENABLED`
  (dialogue.graph.ts написан, не обкатан)
- Dual-path: 11 кронов ИЛИ orchestrator — переключение не выполнено до конца
- Зависимости отстают: LangGraph ^0.2.0 (актуален 1.x), zod ^3.24 (актуален 4.x)

**Стратегический контекст:**
- Официальный X API с февраля 2026: ~$0.20 за пост со ссылкой ⇒ браузерная стратегия подтверждена,
  API — в Hold
- Конкуренты не закрывают: fact-checking, автономный оркестратор с LLM-решениями, сквозную
  атрибуцию до оплаты — наши дифференциаторы

---

## §4 Фазы

### M0 (недели 1–2) — Фундамент измеримости

| # | Зона | Задача | P |
|---|---|---|---|
| M0.1 | Z4 | Prisma-миграция: `Post += ctaUrl String?, attributionLinkId String?, attributionSlug String?`. LeadEvent-модель не нужна — клики/конверсии в zodiac | P1 |
| M0.2 | Z4 | `ILinkPort` (domain port): `createTrackableLink({network, campaign, postId})`, `getFunnelReport(linkId, {from,to})`, `buildDirectUtmUrl(url, {source, campaign, content})`. ADR с контрактом internal-API | P1 |
| M0.3 | Z4* | **Cross-project:** внутренний контроллер `/internal/attribution-links` в `my_zodiac_ai/back` под `MAIN_BACKEND_INTERNAL_TOKEN` (create + funnel-report; переиспользует `AttributionLinksService`). Deploy zodiac-back | P1 |
| M0.4 | Z6 | Аудит зависимостей → отчёт Tech Radar: план LangGraph 0.2→1.x, Zod 3→4, проверка patch-sites `patch-playwright.js` | P1 |
| M0.5 | Z6 | Консолидация planning-доков: шапки «АРХИВ → см. ROADMAP_V2.md» в ROADMAP.md, FEATURE_WISHLIST.md, docs/roadmap/README.md | P2 |
| M0.6 | Z4 | `source-url.util.ts` оживить как ядро fallback-UTM-билдера (закрывает R1) | P2 |

**GATE M0:** миграция применена и протестирована; ADR internal-API согласован и endpoint
задеплоен в zodiac-back; tech-radar отчёт записан; старые доки помечены архивом.

### M1–M2 — Account Foundation

| # | Зона | Задача | P |
|---|---|---|---|
| M1.1 | Z3 | Multi-account core *(01)*: per-account selection вместо «первого активного»; изоляция сессий/контекстов браузера/rate limits/warmup per account; WorldState orchestrator per-account | P1 |
| M1.2 | Z3 | Per-account settings *(02)*: AccountSettings schema + resolver + UI | P2 |
| M1.3 | Z2 | Per-account brand voice *(04)*: AccountPromptProfile, override chain account→global в PromptRegistry, прокидка в graph state | P2 |
| M1.4 | Z3 | Синдикация end-to-end: article-graph outline→draft→publish (Dev.to/Hashnode/LinkedIn long-form); реальная `verifyCanonical()` (закрывает R7) | P2 |
| M1.5 | Z6 | Self-healing фаза 1 *(06)*: ResilienceService скелет, health levels | P2 |

**GATE M1-M2:** 2 аккаунта одной сети работают изолированно (постинг, сессии, лимиты);
статья публикуется end-to-end на Dev.to с canonical-верификацией; brand voice применяется
per-account в генерации.

### M2–M3 — Lead Funnel v1 ⭐ (главная фаза роадмапа)

| # | Зона | Задача | P |
|---|---|---|---|
| M2.1 | Z4 | `ZodiacLinkClient` (adapter → ILinkPort): создание линка перед постингом — `platform={сеть}, medium=social, campaign={категория/месяц}, customFields={post_id}`; destination = `ZODIAC_DEFAULT_DESTINATION_URL`; сохранение shortUrl в Post.ctaUrl. Graceful degradation: zodiac недоступен → `buildDirectUtmUrl()` (M0.6), постинг не блокируется. Circuit breaker + timeout | P1 |
| M2.2 | Z2 | CTA-политика промптов: снять безусловный запрет URL; per-network политика (X: чистый текст + ссылка в первом ответе; Threads/FB: ссылка в посте допустима); обновить draft/judge промпты в Langfuse | P1 |
| M2.3 | Z3 | `postWithReplyLink()`: капабилити постера X/Threads — пост + немедленный первый ответ со ссылкой | P1 |
| M2.4 | Z5 | Conversion dashboard v1: клики→конверсии→revenue по постам/кампаниям/сетям (агрегация funnel-отчётов через client); лента последних кликов | P2 |
| M2.5 | Z4 | Разморозка Replies: soak dialogue.graph; автоответ только на вопросы (question classifier) + safety classifier; эскалация оператору; rate limits на ответы | P2 |

**GATE M2-M3:** первый пост с трекабельной ссылкой опубликован; клик виден в dashboard
(funnel-report отвечает ненулевыми данными); replies ответил на ≥10 реальных вопросов
без инцидентов; fallback-путь проверен (zodiac выключен → пост вышел с прямым UTM).

### M3–M4 — Orchestrator GA

| # | Зона | Задача | P |
|---|---|---|---|
| M3.1 | Z1 | Завершить оставшиеся WS из `.forge/orchestrator/TASKS.md` | P1 |
| M3.2 | Z1 | Self-healing GA *(06)*: ResilienceService, health levels, circuit breakers, auto-recovery playbook | P1 |
| M3.3 | Z1 | Soak test 24–48h staging с реальными сессиями; watchdog проверен (kill → restart) | P1 |
| M3.4 | Z1 | Переключение: `ORCHESTRATOR_ENABLED=true` default; dual-path cron удалён (закрывает R3) | P1 |
| M3.5 | Z5 | Posting windows из реальных метрик (posting-window.service.ts на данных PostMetrics) | P2 |

**GATE M3-M4:** 30 дней uptime ≥99%; ноль пропущенных критических действий (health check,
reconcile); кроны не регистрируются в проде; dual-path код удалён.

### M4–M5 — Scale & Visuals

| # | Зона | Задача | P |
|---|---|---|---|
| M4.1 | Z3 | Валидация сетей: Facebook battle-test, Bluesky/Mastodon/Telegram live-валидация, LinkedIn short-form | P1 |
| M4.2 | Z3 | Image gen *(03)*: IImagePort, Gemini Nano Banana adapter, per-account daily limits, upload в постеры, quota/cost tracking | P2 |
| M4.3 | Z2 | Fact-checking пайплайн v1: claim extraction из draft → верификация → flag/refuse (дифференциатор) | P2 |
| M4.4 | Z5 | Best-time-to-post: окна из накопленных метрик per network/account | P2 |
| M4.5 | Z4 | Bio-link страница v1 (опционально; ссылки теперь идут напрямую в квиз — ценность пересмотреть) | P3 |

**GATE M4-M5:** ≥4 сети в бою стабильно; ≥1 сеть с картинками; fact-check блокирует
фактические ошибки на тестовой выборке.

### M5–M6 — Learning Loop

| # | Зона | Задача | P |
|---|---|---|---|
| M5.1 | Z5 | A/B на масштабе: PostVariant метрики → автоматический выбор победителя → фидбек в hook bank | P1 |
| M5.2 | Z5 | Judge calibration UI: judgeScores ↔ решения оператора, корреляция ≥0.7, правки judge-промпта в Langfuse | P2 |
| M5.3 | Z2 | Hook bank → генерация: топ-хуки как few-shot в hook_generation промпте | P2 |
| M5.4 | Z6 | Token cost optimization *(05)*: semantic cache, prompt compression, cost router, budget ledger | P2 |
| M5.5 | Z4/Z1 | Решение по Engagement разморозке: рефактор в ports-паттерн (R4), soak, go/no-go | P3 |
| M5.6 | Z6 | Закрытие P1-пунктов рефактор-реестра | P2 |

**GATE M5-M6:** цикл A/B замкнут (вариант→метрика→победитель→промпт); корреляция
judge↔человек измерена и ≥0.7; стоимость/пост снижена или причина задокументирована.

---

## §5 Tech Radar

| Кольцо | Технологии |
|---|---|
| **Adopt** | Structured outputs (Zod-схемы во всех LLM-вызовах где возможно); семантический LLM-кэш; Langfuse datasets/experiments для eval-наборов |
| **Trial** | LangGraph 0.2→1.x (сильно отстаём; assessment в M0.4, миграция — отдельная задача после GA); Zod 3→4; MCP-обёртка над SPA как инструмент для внешних агентов |
| **Assess** | Deep Agents/subagents для декомпозиции генерации; computer-use модели vs селекторы Camoufox (соотношение риск/выгода сомнительно — антидетект важнее); официальные API там где дёшево (Telegram уже API) |
| **Hold** | Новые сети сверх условий входа из §9 (одна платформа за итерацию, soak ≥2 недель); официальный X API ($0.20/пост со ссылкой с февраля 2026 — браузерная стратегия подтверждена правилом транспорта §9); multi-tenant SaaS/RBAC/биллинг; собственная ссылочная инфраструктура (redirects/slugs/click-tracking — живёт в my_zodiac_ai/back) |

Правило: переход кольца Adopt←Trial только через ADR с soak-периодом ≥2 недель.

---

## §6 Рефактор-реестр

Источник: `docs/refactor/phase-1..7` + аудит августа 2026.

| ID | P | Что | Когда |
|---|---|---|---|
| R1 | P1 | `source-url.util.ts` (мёртвый код) → оживить как ядро fallback-UTM-билдера `ILinkPort` | M0.6 |
| R2 | P1 | Унификация импортов: `.js`-расширения (orchestrator, ESM) vs без расширений (остальное, CJS-стиль). Зафиксировать конвенцию в AGENTS.md; приводить файлы к стилю при касании | постоянно |
| R3 | P1 | Dual-path cron/orchestrator: удалить cron-ветку после GA | M3.4 |
| R4 | P2 | Engagement frozen code (~1300 строк): рефактор в ports-паттерн ДО любого включения | M5.5 |
| R5 | P2 | `process.env` прямые чтения: намеренные оставить задокументированными (AGENTS.md — static contexts/module loaders), остальные → ConfigService | постоянно |
| R6 | P2 | Planning docs consolidation: архивные шапки | M0.5 |
| R7 | P2 | `CanonicalUrlService.verifyCanonical()` заглушка → реальная проверка | M1.4 |
| R8 | P3 | UI component/view тесты (P2 из старого ROADMAP.md) | backlog |

---

## §7 Non-goals

- **Собственная ссылочная инфраструктура** — redirect endpoints, шортенер, модель кликов.
  Всё это уже есть в `my_zodiac_ai/back` (`attribution-links`) и развивается там
- Reddit / Quora / Substack / RU-платформы без API — до выполнения условий входа из §9 (бан-риск / репутационный риск)
- Официальный X API для постинга — экономика не сходится ($0.20/пост со ссылкой)
- Multi-tenant SaaS, RBAC для внешних пользователей, биллинг
- Видео-генерация
- Отдельный shortener-домен (короткие ссылки живут на домене квиза zodiac)

---

## §8 Карта архива

| Документ | Статус | Судьба |
|---|---|---|
| `ROADMAP.md` | АРХИВ | Фазы 0–6 и sprints A–G завершены; шапка-указатель на этот файл (M0.5) |
| `FEATURE_WISHLIST.md` | АРХИВ | F1-F22 разошлись: F13/F19/F20/F21 done; F2/F10/F22 backend done; F8 инфраструктура есть (PostVariant); F1/F4 → Z5/M5; F6/F7 → Z5/M4-M5; F11 → Z3/M4 |
| `docs/roadmap/01..07` | АКТИВНЫЕ пропозалы | 01,02,04 → M1-M2; 03 → M4; 05 → M5; 06 → M3; 07 → M4-M5 |
| `.forge/orchestrator/MASTER-PLAN.md` + `TASKS.md` | РАБОЧИЙ план Z1 | Закрывается в M3-M4 |
| `docs/refactor/phase-1..7` | Источник | Перенесён в §6 (R1-R8) |
| `CONSTITUTION.md` §16 | Актуально | Трекинг фич остаётся; статусы синхронизируются с этим файлом |
| `AGENTS.md` / `CLAUDE.md` | Актуальны | Операционные конвенции; дополнить конвенцией импортов (R2) и Z4-env |

---

## §9 Parking lot — публикация на множество ресурсов

### Правило выбора транспорта (решение владельца, 2026-08-22)

> **Бесплатный официальный API есть → используем API. Платный или отсутствует → stealth browser (Camoufox).**

Транспорт фиксируется в capability-манифесте платформы; поведения различаются, контракт — общий.

| | API-publisher | StealthBrowser-publisher |
|---|---|---|
| Скорость поста | секунды | минуты (human-like pacing) |
| Параллелизм | свободный | ограничен пулом браузеров |
| Бан-риск | нет (официальный канал) | управляемый (warmup, лимиты, отпечатки) |
| Хрупкость | версии API | селекторы/DOM |
| Стоимость | $0 | браузерная инфраструктура |

### Архитектура fan-out («один контент → N ресурсов одновременно»)

```
GeneratedPost (выход графа, уже с ctaUrl из Z4)
   ▼
PublisherRegistry ─► capability manifest per platform
   │                 {transport: api|browser, maxChars, media,
   │                  ctaPolicy, replyLinkSupport, rateLimits}
   ▼
PublishFanout (BullMQ fan-out, job = platform × account)
   ├── api.publisher       Dev.to, Hashnode, Medium, Telegram, Bluesky…
   └── browser.publisher   X, Threads, FB, Quora… (общий Camoufox pool)
   ▼
verifyPosted() → PostMetrics scraper → funnel-отчёты zodiac → дашборд
```

Требования к fan-out (ничего не блокируется):

- **Изоляция**: queue-per-platform, timeout per job — падение одной платформы не задерживает остальные
- **Circuit breaker per platform**: 3 неудачи подряд → cooldown 30 мин → алерт оператору; платформа пропускает цикл, остальные работают
- **Логирование каждой попытки**: `{platform, accountId, attempt, outcome, latencyMs, screenshotRef}` (скриншот — для браузерного пути); корреляция с Langfuse trace runId; Sentry для crash-level
- **Graceful degradation матрица**: zodiac недоступен → прямой UTM (M2.1); платформа недоступна → skip + отчёт в дашборд; сессия истекла → relogin flow → эскалация оператору
- **Наблюдаемость**: success-rate per platform за неделю на дашборде Z5; алерт при деградации любой платформы ниже порога

### Кандидаты (классификация по правилу транспорта)

| Платформа | Транспорт по правилу | Статус | Условие входа |
|---|---|---|---|
| X | browser (Basic $200+/мес, ~$0.20/пост со ссылкой) | в бою | — |
| Threads | browser сейчас; официальный **Threads API бесплатен** (Meta app review, привязка к IG professional) → миграция на API по правилу | в бою; assess миграции | после GA M3-M4 |
| Facebook | browser для профиля; **Graph API бесплатен для Pages** → если ведём Page, переход на API | в бою; решение | при мультиаккаунте M1-M2 |
| Dev.to | API (free) | M1.4 | — |
| Hashnode | GraphQL API (free) | M1.4 | — |
| LinkedIn | API (free; w_member_social, app review) — articles M1.4, short-form M4.1 | в плане | — |
| Medium | API (free, integration token) | parking | после GATE M1-M2, расширение article-graph |
| Telegram (канал) | Bot API (free) | M4.1 | — |
| Bluesky | AT Protocol API (free) | M4.1 | — |
| Mastodon | REST API (free) | M4.1 | — |
| Tumblr | API (free) | parking | P3 |
| WordPress / Ghost / Blogger | API (free) | parking | P3 — свой SEO-хаб; решить после лид-метрик M2-M3 |
| VK | API (free) | parking | P3, RU-аудитория |
| Instagram | Content Publishing API (free; Business-аккаунт, только фото/видео) | parking | после image gen M4.2 |
| Pinterest | API v5 (free; визуальный контент) | parking | после image gen M4.2 |
| Reddit | API условно-бесплатный (rate limits; коммерческое использование — платное соглашение); модерация сабреддитов строже технических банов | Hold | ADR после GA M3-M4 — риск репутационный, не технический |
| Quora | API нет → browser | Hold | высокий бан-риск; вернуться после GA |
| Substack | официального API нет → browser-assess | Hold | ценность/усилия сомнительны |
| Habr / VC.ru / Дзен | стабильного API нет → browser-assess | Hold | RU-контур, если «зайдёт» VK |

**Правило входа:** не более одной новой платформы за итерацию; soak ≥2 недель до добавления следующей. Одновременная нагрузка ограничена пулом браузеров и per-account лимитами (M1.1). API-платформы масштабируются свободнее — приоритет отдавать им.

---

## §10 Changelog

| Дата | Версия | Изменения |
|---|---|---|
| 2026-08-22 | 2.0 | Первичная редакция: цели лидогенерации, зоны Z1-Z6, фазы M0-M6, интеграция атрибуции с `my_zodiac_ai/back` (internal-token, destination = quiz funnel, fallback = прямой UTM), Tech Radar, рефактор-реестр, архивация ROADMAP.md / FEATURE_WISHLIST.md |
| 2026-08-22 | 2.1 | §9 Parking lot: правило выбора транспорта (free API → API, иначе stealth browser), архитектура fan-out публикации на N ресурсов (изоляция, circuit breaker per platform, логирование, graceful degradation), таблица кандидатов с условиями входа |
