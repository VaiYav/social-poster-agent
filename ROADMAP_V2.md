# ROADMAP V2 — от автопостера к лид-машине

> ## 🗄️ ARCHIVED (2026-08-23)
> Канонический роадмап переехал: **[`docs/planning/ROADMAP.md`](./docs/planning/ROADMAP.md)**
> (английский, v3.0, снапшот §3 актуализирован). Этот файл — русская оригинальная
> редакция v2.4; НЕ обновляется и не владеет статусом.

> **Роль документа:** цели, milestone-последовательность и GATE'ы.
> **Канонические статусы фич и задач:**
> [`docs/planning/FEATURES.md`](./docs/planning/FEATURES.md) и
> [`docs/planning/BACKLOG.md`](./docs/planning/BACKLOG.md).
> Dependency waves и правила взятия задач: [`docs/planning/EXECUTION_ROADMAP.md`](./docs/planning/EXECUTION_ROADMAP.md).
> Статусы/checklist'ы в roadmap/spec/review-файлах не являются источником текущего
> состояния и не должны обновляться параллельно с planning hub.

> **Версия:** 2.4 · **Дата:** 2026-08-22 · **Статус:** ACTIVE
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
| *(NN)* | Ссылка на proposal из `docs/roadmap/01..14` или на другой док; status по feature ID смотрите в `docs/planning/FEATURES.md` |

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
| Reply-assisted результат | direct/assisted/incremental отчёты разделены; conversions/revenue per approved reply *(11)* | — |

### Цель 2 — Узнаваемость бренда

| KPI | Как меряем |
|---|---|
| Рост подписчиков | дельта по аккаунтам за 30д (PostMetrics + профили) |
| Impressions / engagement rate | PostMetrics (likes/comments/shares/impressions), скрапинг уже есть |
| Стабильность присутствия | % дней с ≥1 публикацией на сеть (orchestrator health) |
| Качество разговоров | approval/edit rate suggestions, author reply rate, повторные содержательные interactions *(08)* |
| Спрос из разговоров | validated demand clusters → topics/FAQ/product insight и matched outcome delta *(10)* |
| Партнёрства с creators | reciprocal relationships, accepted/completed collaborations, attributed outcomes *(13)* |

### Цель 3 — Качественная агентская система

| KPI | Как меряем |
|---|---|
| Uptime автономного цикла | ≥99% за 30 дней (watchdog + self-healing) |
| Доля действий без оператора | orchestrator actions / ручные вмешательства |
| Стоимость на пост | токен-телеметрия Langfuse, $/пост, тренд вниз |
| Качество контента | judgeScores (anti_ai_tone ≥0.7) + корреляция с решениями оператора |
| Стабильность persona | persona fidelity/distinctness, contradiction rate, unsupported-claim rate *(08)* |
| AI release quality | PASS/FAIL/ERROR gates, critical regression count, drift/rollback *(09)* |
| Policy/reputation health | stale policy blocks, reputation state, time-to-contain/recover *(12)* |

---

## §2 Зоны ответственности

Работа разбита на 6 зон. Зона = «кто владеет проблемой», а не директория кода.

### Z1 — Orchestrator & Reliability
Автономный цикл OBSERVE→DECIDE→ACT как единственный путь выполнения.
13 action handlers, adaptive sleep, watchdog (`*/5 * * * *`). Завершение work streams
из `.forge/orchestrator/TASKS.md` (WS-1..WS-8), self-healing *(06)*, GA-переключение
(`ORCHESTRATOR_ENABLED=true` default, 11 кронов не регистрируются), удаление dual-path.
Platform Policy & Reputation Control Plane *(12)* ограничивает execution capability и может
идемпотентно понизить/поставить на паузу account/topic/action scope.
Владелец GATE'а: uptime ≥99%.

### Z2 — Content Intelligence
Промпты и качество генерации: research → hooks → draft → critique → refine → judge
(Langfuse Prompt Management, 7 промптов). CTA-политика (снятие запрета URL),
versioned EditorialPersona + AuthorContext + memory/RAG *(04,08)*, fact-checking пайплайн
(дифференциатор — никто из
конкурентов Postiz/Mixpost/Typefully/Hypefury/Buffer/Publer/Taplio этого не делает),
persona/first-person/sensitive-domain gates, hook bank → few-shot обратная связь.
Conversation Intelligence/Demand Radar *(10)*, Cross-Account Portfolio Planner *(08)* и
read-only Soulwise Editorial Data Bridge *(14)* формируют source→opportunity→assignment контур.

### Z3 — Accounts & Networks
Мультиаккаунтность *(01)*: per-account выбор вместо `findByNetwork()` → первый активный;
изоляция сессий/браузерных контекстов/лимитов/warmup per account. Per-account настройки *(02)*.
Persona assignment и platform execution policy для conversational engagement *(08)*.
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

Reply-first measurement расширяется privacy-safe account/persona/time cohort слоем *(11)*:
direct attribution остаётся canonical в zodiac, assisted association и incremental estimate
хранятся/показываются как разные типы доказательств.

### Z5 — Analytics & Learning
Дашборды (Next.js UI): conversion dashboard v1, judge calibration, best-time-to-post.
A/B на масштабе: `PostVariant` (инфраструктура описана в `docs/features/ab-testing-infrastructure.md`)
→ метрики → авто-выбор победителя → фидбек в hook bank. Persona/mode experiments и
conversation outcomes хранят отдельные normalized assignments *(08)*, не используют
`PostVariant.label` как persona ID. Posting windows из реальных PostMetrics.
Demand clusters/outcomes *(10)*, assisted/incremental reporting *(11)* и Creator Relationship CRM
*(13)* питают learning loop, но не могут автоматически ослаблять safety/policy gates.

### Z6 — Platform Health
Tech Radar (§5): апгрейды LangGraph 0.2→1.x, Zod 3→4, аудит playwright-core patch sites.
Рефактор-реестр (§6). Консолидация planning-доков (§8). Token cost optimization *(05)*.
ResilienceService скелет *(06)*. AI Change Release Gate *(09)* и policy-drift registry *(12)*
владеют pre-release и external-policy evidence.

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
- EditorialPersona, revision/assignment, durable persona/interaction memory и suggestion queue
  отсутствуют; текущий comment-first может превратить non-comment action в комментарий без
  отдельного value/policy gate *(08)*
- Нет blocking AI release manifest/dataset gate *(09)*, demand clusters *(10)*,
  reply-assisted/incrementality measurement *(11)*, policy/reputation control plane *(12)*,
  creator relationship workflow *(13)* и typed Soulwise editorial feed *(14)*
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
| M0.7 | Z2/Z5/Z6 | AI Change Release Gate *(09)*: failure taxonomy, versioned Langfuse datasets, deterministic/LLM/retrieval evaluators, side-effect-free runner, immutable release manifest, trusted GitHub gate; FAIL/ERROR blocks AI promotion | P1 |
| M0.8 | Z3/Z6 | Platform Policy Registry foundation *(12)*: primary evidence/version/expiry, most-restrictive compiler, runtime authorizer, downgrade-only source drift | P1 |

**GATE M0:** миграция применена и протестирована; ADR internal-API согласован и endpoint
задеплоен в zodiac-back; tech-radar отчёт записан; старые доки помечены архивом; seeded AI
regression блокируется без реального side effect; evaluator ERROR не становится PASS; каждый
enabled side-effect action имеет unexpired evidence-backed compiled policy.

### M1–M2 — Account Foundation

| # | Зона | Задача | P |
|---|---|---|---|
| M1.1 | Z3 | Multi-account core *(01)*: per-account selection вместо «первого активного»; изоляция сессий/контекстов браузера/rate limits/warmup per account; WorldState orchestrator per-account | P1 |
| M1.2 | Z3 | Per-account settings *(02)*: AccountSettings schema + resolver + UI | P2 |
| M1.3 | Z2/Z3 | EditorialPersona v1 *(04,08)*: immutable persona revisions, account assignment, AuthorContext, safe prompt variables, account-specific graph invocation и normalized trace fields; Langfuse labels остаются для экспериментов, а не для каждого аккаунта | P1 |
| M1.4 | Z3 | Синдикация end-to-end: article-graph outline→draft→publish (Dev.to/Hashnode/LinkedIn long-form); реальная `verifyCanonical()` (закрывает R7) | P2 |
| M1.5 | Z6 | Self-healing фаза 1 *(06)*: ResilienceService скелет, health levels | P2 |
| M1.6 | Z2/Z3 | Cross-Account Portfolio Planner *(08)*: EditorialOpportunity/Assignment, thesis hash/saturation, hard persona/policy/portfolio constraints, explainable account+action+angle+mode decision | P1 |

**GATE M1-M2:** 2 аккаунта одной сети работают изолированно (постинг, сессии, лимиты);
статья публикуется end-to-end на Dev.to с canonical-верификацией; каждый новый Post сохраняет
immutable persona revision + voice mode, а парный eval различает две persona; unsupported
first-person claims блокируются; planner не назначает duplicate/contradictory thesis двум аккаунтам
и сохраняет explainable constraint/score trace.

### M2–M3 — Lead Funnel v1 ⭐ (главная фаза роадмапа)

| # | Зона | Задача | P |
|---|---|---|---|
| M2.1 | Z4 | `ZodiacLinkClient` (adapter → ILinkPort): создание линка перед постингом — `platform={сеть}, medium=social, campaign={категория/месяц}, customFields={post_id}`; destination = `ZODIAC_DEFAULT_DESTINATION_URL`; сохранение shortUrl в Post.ctaUrl. Graceful degradation: zodiac недоступен → `buildDirectUtmUrl()` (M0.6), постинг не блокируется. Circuit breaker + timeout | P1 |
| M2.2 | Z2 | CTA-политика промптов: снять безусловный запрет URL; per-network политика (X: чистый текст + ссылка в первом ответе; Threads/FB: ссылка в посте допустима); обновить draft/judge промпты в Langfuse | P1 |
| M2.3 | Z3 | `postWithReplyLink()`: капабилити постера X/Threads — пост + немедленный первый ответ со ссылкой | P1 |
| M2.4 | Z5 | Conversion dashboard v1: клики→конверсии→revenue по постам/кампаниям/сетям (агрегация funnel-отчётов через client); лента последних кликов | P2 |
| M2.5 | Z4 | Разморозка Replies: soak dialogue.graph; автоответ только на вопросы (question classifier) + safety classifier; эскалация оператору; rate limits на ответы | P2 |
| M2.6 | Z2/Z3/Z5 | Conversational engagement pilot *(08)*: закрыть R4 ports-refactor, deterministic value/policy gate, bounded thread context, persisted suggestion queue + operator review; Threads=`HUMAN_APPROVAL_REQUIRED`, X outbound=`SUGGEST_ONLY`; no fabricated experience or generic fallback replies | P1 |
| M2.7 | Z2/Z5 | Conversation Intelligence & Demand Radar pilot *(10)*: minimized public signals, typed extraction, reviewed clusters, transparent demand score, cluster→Topic/FAQ/product-insight proposals | P2 |
| M2.8 | Z4/Z5 | Reply-to-Revenue v1 *(11)*: stable account/persona bio links, ConversationActivityWindow, direct versus assisted association dashboard, unknown/late data quality | P1 |
| M2.9 | Z2/Z4* | **Cross-project:** Soulwise Editorial Feed v1 *(14)*: strict PUBLIC_FACT envelope, today-sky adapter, internal-token cursor/ETag API, dedicated SPA client/adapter; no personalized endpoints | P1 |

**GATE M2-M3:** первый пост с трекабельной ссылкой опубликован; клик виден в dashboard
(funnel-report отвечает ненулевыми данными); replies ответил на ≥10 реальных вопросов
без инцидентов; fallback-путь проверен (zodiac выключен → пост вышел с прямым UTM);
conversation pilot не позволяет обойти execution policy, `skip` остаётся terminal, X не имеет
пути unsolicited auto-reply, а два persona-голоса различимы в held-out reply eval.
Demand Radar хранит только privacy-eligible reviewed clusters; direct и assisted attribution
разделены; Editorial Feed producer/consumer contract блокирует forbidden user-level fields.

### M3–M4 — Orchestrator GA

| # | Зона | Задача | P |
|---|---|---|---|
| M3.1 | Z1 | Завершить оставшиеся WS из `.forge/orchestrator/TASKS.md` | P1 |
| M3.2 | Z1 | Self-healing GA *(06)*: ResilienceService, health levels, circuit breakers, auto-recovery playbook | P1 |
| M3.3 | Z1 | Soak test 24–48h staging с реальными сессиями; watchdog проверен (kill → restart) | P1 |
| M3.4 | Z1 | Переключение: `ORCHESTRATOR_ENABLED=true` default; dual-path cron удалён (закрывает R3) | P1 |
| M3.5 | Z5 | Posting windows из реальных метрик (posting-window.service.ts на данных PostMetrics) | P2 |
| M3.6 | Z1/Z3/Z6 | Reputation Monitor *(12)*: technical/public/behavioral signals, HEALTHY→WATCH→LIMITED→PAUSED→INCIDENT, multi-signal rules, scoped FlowControl auto-pause and staged recovery | P1 |
| M3.7 | Z2/Z6 | AI gate shadow/nightly drift *(09)*: fixed judge/safety/retrieval slices, production prompt/model/manifest drift, recording side-effect ports, rollback-capable canary | P1 |

**GATE M3-M4:** 30 дней uptime ≥99%; ноль пропущенных критических действий (health check,
reconcile); кроны не регистрируются в проде; dual-path код удалён; seeded reputation incidents
дают expected scoped state/effects, sentiment-only не паузит аккаунт, nightly gate замечает seeded
drift, canary/rollback не создаёт duplicate side effects.

### M4–M5 — Scale & Visuals

| # | Зона | Задача | P |
|---|---|---|---|
| M4.1 | Z3 | Валидация сетей: Facebook battle-test, Bluesky/Mastodon/Telegram live-валидация, LinkedIn short-form | P1 |
| M4.2 | Z3 | Image gen *(03)*: IImagePort, Gemini Nano Banana adapter, per-account daily limits, upload в постеры, quota/cost tracking | P2 |
| M4.3 | Z2 | Fact-checking пайплайн v1: claim extraction из draft → верификация → flag/refuse (дифференциатор) | P2 |
| M4.4 | Z5 | Best-time-to-post: окна из накопленных метрик per network/account | P2 |
| M4.5 | Z4 | Bio-link страница v1 (опционально; ссылки теперь идут напрямую в квиз — ценность пересмотреть) | P3 |
| M4.6 | Z2/Z5 | Durable persona memory + grounding *(08)*: reviewed KnowledgeEvidence, memory candidates, contradiction/expiry/purge lifecycle, Postgres FTS + pgvector hybrid retrieval behind ports, retrieval/claim trace | P2 |
| M4.7 | Z5 | Creator Relationship CRM *(13)*: public network identity, evidence-backed relationship stage, cooldown/DO_NOT_ENGAGE, human-reviewed collaboration opportunities; no automated outreach | P2 |
| M4.8 | Z2/Z4* | Soulwise Editorial Feed expansion *(14)*: curated knowledge/product updates, review/validity/tombstones, KnowledgeEvidence mapping and retraction re-index; AGGREGATE_INSIGHT остаётся HOLD | P2 |

**GATE M4-M5:** ≥4 сети в бою стабильно; ≥1 сеть с картинками; fact-check блокирует
фактические ошибки на тестовой выборке; held-out retrieval/evidence thresholds пройдены,
stale/contradictory evidence не инжектится, privacy purge удаляет lexical/vector retrieval.
Creator CRM не содержит private/sensitive enrichment и не имеет auto-outreach; Editorial Feed
tombstone/expiry удаляет eligibility/cache/retrieval и cross-project rollback проверен.

### M5–M6 — Learning Loop

| # | Зона | Задача | P |
|---|---|---|---|
| M5.1 | Z5 | A/B на масштабе: PostVariant метрики → автоматический выбор победителя → фидбек в hook bank | P1 |
| M5.2 | Z5 | Judge calibration UI: judgeScores ↔ решения оператора, корреляция ≥0.7, правки judge-промпта в Langfuse | P2 |
| M5.3 | Z2 | Hook bank → генерация: топ-хуки как few-shot в hook_generation промпте | P2 |
| M5.4 | Z6 | Token cost optimization *(05)*: semantic cache, prompt compression, cost router, budget ledger | P2 |
| M5.5 | Z2/Z3/Z5 | Conversational autonomy go/no-go *(08)* после M2.6 pilot: калибровка persona/safety judges, normalized persona/mode experiments, approved-edit learning; Threads promotion только с policy/API evidence, X остаётся suggest-only без explicit approval | P2 |
| M5.6 | Z6 | Закрытие P1-пунктов рефактор-реестра | P2 |
| M5.7 | Z2/Z5/Z6 | Fine-tuning assessment *(08)*: prompt+few-shot+RAG baseline, approved dataset, quality/cost comparison, shared persona-conditioned renderer ADR или зафиксированный NO-GO | P3 |
| M5.8 | Z2/Z4/Z5 | Conversation learning evidence *(10,11,13)*: demand-derived matched outcomes, pre-registered reply incrementality report, collaboration direct/assisted outcomes; insufficient sample returns NO-CONCLUSION | P2 |

**GATE M5-M6:** цикл A/B замкнут (вариант→метрика→победитель→промпт); корреляция
judge↔человек измерена и ≥0.7; persona learning reproducible/versioned/reversible и не ухудшает
truth/safety; стоимость/approved output снижена или причина задокументирована; execution-mode и
fine-tuning решения имеют отдельные evidence-backed go/no-go записи; assisted association не
выдаётся за causal lift, incrementality/creator/demand reports возвращают uncertainty либо
NO-CONCLUSION и не продвигают strategy автоматически.

---

## §5 Tech Radar

| Кольцо | Технологии |
|---|---|
| **Adopt** | Structured outputs (Zod-схемы во всех LLM-вызовах где возможно); семантический LLM-кэш; Langfuse versioned datasets/experiments + blocking AI release manifest *(09)*; evidence-backed most-restrictive action policy *(12)* |
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
| R4 | P1 | Engagement frozen code (~1300 строк): разделить candidate scoring, decision, suggestion, execution и recording за ports ДО conversational pilot; comment budget не может создавать действие | M2.6 |
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
- Unsolicited automated replies и keyword-triggered comment spam; X outbound replies остаются
  `SUGGEST_ONLY` без explicit platform approval, Threads — approval-required до отдельного go/no-go *(08)*
- Выдача synthetic editorial persona за реального человека и fabricated lived experience *(08)*
- Отдельный vector DB и per-account fine-tuned models в первом persona-релизе *(08)*
- User-level identity stitching social→quiz и assisted association, названная causal attribution *(11)*
- Автоматическая policy promotion, sentiment-only autopause и попытки обходить enforcement *(12)*
- Automated creator DMs/outreach, private contact enrichment и sensitive/psychographic profiling *(13)*
- Экспорт Soulwise birth/cycle/couple/chat/personalized data; AGGREGATE_INSIGHT до отдельного privacy ADR *(14)*
- Multi-tenant SaaS, RBAC для внешних пользователей, биллинг
- Видео-генерация
- Отдельный shortener-домен (короткие ссылки живут на домене квиза zodiac)

---

## §8 Карта архива

| Документ | Статус | Судьба |
|---|---|---|
| `ROADMAP.md` | АРХИВ | Фазы 0–6 и sprints A–G завершены; шапка-указатель на этот файл (M0.5) |
| `FEATURE_WISHLIST.md` | АРХИВ | F1-F22 разошлись: F13/F19/F20/F21 done; F2/F10/F22 backend done; F8 инфраструктура есть (PostVariant); F1/F4 → Z5/M5; F6/F7 → Z5/M4-M5; F11 → Z3/M4 |
| `docs/roadmap/01..14` | СПЕЦИФИКАЦИИ | Описывают intent/design; feature/task status живёт только в `docs/planning/` |
| `.forge/orchestrator/MASTER-PLAN.md` + `TASKS.md` | LEGACY детализация Z1 | Сверяется через `ORCH-001`/`ORCH-101` в planning hub; не владеет глобальным статусом |
| `docs/refactor/phase-1..7` | Источник | Перенесён в §6 (R1-R8) |
| `CONSTITUTION.md` §16 | Требования/история | Не владеет статусом; актуальный feature register — `docs/planning/FEATURES.md` |
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
| 2026-08-22 | 2.2 | Proposal *(08)*: versioned EditorialPersona, AuthorContext, Threads/X conversational suggestion policy, перенос R4 в M2.6, durable persona memory/RAG в M4.6, persona learning и fine-tuning go/no-go в M5–M6 |
| 2026-08-22 | 2.3 | Proposals *(09–14)*: blocking AI release gate, Demand Radar, direct/assisted/incremental reply attribution, cross-account portfolio planning, platform-policy/reputation control plane, creator relationship CRM и read-only Soulwise Editorial Data Bridge |
| 2026-08-22 | 2.4 | Canonical execution roadmap: Wave 0–6 dependency order, current work-intake queue, WIP/file-ownership rules, task IDs for missing milestone slices и evidence-first handoff |
