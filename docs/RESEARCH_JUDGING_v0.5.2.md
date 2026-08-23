# Judging стороннего ресерча по Social Poster Agent

> **HISTORICAL RESEARCH SNAPSHOT.** This remains evidence about a prior review.
> Current judge/calibration design is `docs/evaluation/07-*`; live task status is in
> `docs/planning/BACKLOG.md`.

> **Версия SPA:** 0.5.2 | **Дата:** 2026-07-10 | **Автор проверки:** AI-агент (сверка с исходниками)
> **Предмет:** «Обзор Social Poster Agent: текущая концепция и приоритеты»
>
> Документ судит сторонний ресерч по SPA: что подтверждается кодом, что фактически
> неверно, что упущено. Все утверждения сверены с исходниками на момент v0.5.2.
> Источник истины — код, а не прозаические доки (см. `CLAUDE.md` → «The docs lag the code»).

---

## TL;DR — вердикт

Ресерч верен по инстинктам (порядок «RAM/стоимость → стабилизация → качество») и точен
в разделе «что уже хорошо». Но как judging он проваливается в двух местах:

1. **Заголовочный P0 фактически неверен.** Утверждение «в docker-compose нет
   memory/CPU limits» смотрит на dev-файл `infra/docker-compose.yml`; production-стек
   `docker/docker-compose.prod.yml` лимиты **имеет**. Ещё два P0-пункта (pool=1,
   allkeys-lru) **уже сделаны** в коде. То есть половина «быстрых P0-win» — работа,
   которая не нужна или уже есть.
2. **План мимо главного риска продукта** — бан аккаунтов и алгоритмическое
   подавление AI-контента. Ни строки про residential proxy, бурст-паттерн cron,
   детект AI-текста. Это важнее RAM.

Реальная ценность ресерча — в P1–P2 (баг с `AbortController` в `generate()`,
неучёт `cost`, некалиброванный judge), а не в P0.

---

## 1. Сверка утверждений с кодом

| Утверждение ресерча | Факт в коде | Вердикт |
|---|---|---|
| «в docker-compose нет memory/CPU limits» (P0 #1) | `docker/docker-compose.prod.yml` **имеет** `deploy.resources.limits`: backend 2G/2 cpu, postgres 1G, redis 512M, ui 512M. Ресерч цитировал `infra/docker-compose.yml` — локальный dev-стек (только PG+Redis), где лимиты не нужны | ❌ **Ложь.** Заголовочный P0 неверен |
| «Redis без maxmemory / allkeys-lru» | prod-compose стр. 34: `--maxmemory 256mb --maxmemory-policy allkeys-lru` уже стоит | ❌ Уже сделано |
| «BROWSER_POOL_SIZE=3 → поставь 1» | Дефолт в коде (`browser.factory.ts:130`) **уже 1**, с MEM-комментарием ровно про эту логику. `3` стоит только в `.env.example` | ⚠️ Полу-правда: чинить `.env.example`, не код |
| «TOPIC_BATCH_SIZE=20 → 20 тем × 13 вызовов» | `TOPIC_BATCH_SIZE` — генерация *пула идей тем*, не постов. Cron делает **3 темы/запуск** (`cron.service.ts:68`), `MAX_CONCURRENCY=3` (`generation.service.ts:361`) | ⚠️ Путаница: batch 10 vs 20 почти не влияет на нагрузку генерации постов |
| «CAMOUFOX_PROFILE_DIR=/tmp — риск plaintext cookies» | Верно (`.env.example:245`); код уже логирует prod-варнинг (`browser.factory.ts:165-170`) | ✅ Валидно, частично прикрыто |
| «CAMOUFOX_MEMORY_PREFS / BLOCK_IMAGES_READONLY включены» | Подтверждено (дефолты `true`) | ✅ Верно |
| «BROWSER_MAX_LIFETIME_MS=15m, PERSISTENT_CONTEXT_IDLE_TTL=15m» | Подтверждено (`browser.factory.ts:146-148`) | ✅ Верно |
| «cost в LlmResponse не считается» | Устарело: `LlmService.estimateCost()` (`llm.service.ts:877`) заполняет `cost` в каждом `LlmResponse`, а `GenerationService` (`generation.service.ts:431`) агрегирует `runCost` | ⚠️ Уже сделано, документация не обновлена |
| «AbortController только в resumeRun, не в generate()» | Устарело: `generate()` (`generation.service.ts:275`) создаёт `AbortController`, пишет в `activeRuns` и передаёт `signal` в `graph.invoke`; `resumeRun` тоже передаёт `signal` (исправлено в этом ревью) | ⚠️ Устаревшая находка, логика прерывания работает |
| «Reconciliation грузит 1000 постов/час» | Верно (`health-monitor.service.ts:117`), но это уже safety-cap с комментарием, обработка последовательная | ✅ Верно, но низкий приоритет |
| «removeOnComplete/Fail по count, не по возрасту» | Подтверждено (`queue.factory.ts:214-215` → count 100/500) | ✅ Верно, минор |
| «Judge: один retry при anti_ai_tone<0.6, без калибровки» | Подтверждено (`generation.graph.ts:1010`, `refineThreshold=0.6`, env `JUDGE_REFINE_THRESHOLD`) | ✅ Верно |
| «postById обрабатывает POSTING/FAILED/REJECTED» | Подтверждено (`posting.service.ts:138-165`) | ✅ Верно |

**Итог по judging:** P0 #1 фактически неверен, ещё 2 P0-пункта уже в коде. Ценность —
в P1–P2.

---

## 2. Что ресерч полностью упустил

### 2.1. Главный риск — не RAM, а бан аккаунтов и подавление AI-контента

Две независимые полевые выборки (~2000 аккаунтов, 2025–26) сходятся: **~70% банов =
«спящий аккаунт → всплеск действий» + IP/fingerprint-mismatch** (датацентр вместо
residential). Профиль SPA ровно такой:

- Cron `0 9,13,18,22` — бурст-паттерн (публикация пачкой после простоя).
- Деплой в Docker → датацентр IP (AWS/Hetzner/OVH — «heavily flagged»).
- AI-генерируемый текст → алгоритмическое подавление даже без бана.
- X с февраля 2026 официально ужесточил политику по автоматизации.

Весь план ресерча — про RAM/cost, экзистенциальный риск продукта не адресован. Это
самый серьёзный пропуск. Браузерная автоматизация сама по себе (Camoufox) — **не**
основной вектор; решает поведение и fingerprint/IP.

### 2.2. Лимиты контейнера не лечат утечку — только маскируют

Утечка Camoufox реальна и подтверждена upstream (daijro/camoufox #245, #87, #363):
RSS растёт часами до OOM даже при 0 вкладок — jemalloc-фрагментация, JIT/NSS-кэши.
Правильная митигация — рестарт браузера по памяти/времени, и он **уже есть**
(`BROWSER_MAX_LIFETIME_MS`). Community-форк добавил рестарт по *native-mem-pressure*
(порог `RSS − heapUsed`), а не только по таймеру — вот это стоит перенять.
`deploy.limits` без рестарта просто превращает утечку в OOM-Kill.

### 2.3. Калибровка judge — идея верная, метод в ресерче наивный

Литература (Evidently, Arize, Galileo, HuggingFace cookbook) даёт конкретику,
которой в плане нет:

- **Бинарный вердикт** вместо непрерывного `anti_ai_tone` 0..1 — произвольные
  числовые шкалы плохо воспроизводимы.
- **50–100 размеченных примеров** (обычные + явные фейлы), train/dev/test split.
- Метрика — **Cohen's kappa** против потолка «human-human agreement», не raw accuracy.
- **Few-shot рубрики** прямо в промпте judge; порог тюнить итеративно, репортить на
  held-out.

Текущий порог 0.6 — угаданное число, а не откалиброванное.

---

## 3. Пересмотренный план

### P0 — реальные быстрые win (переписано)

- Выровнять `.env.example` под безопасные дефолты кода: `BROWSER_POOL_SIZE=1`,
  `MAX_PARALLEL_BROWSERS≤2`, `CHECKPOINT_TTL_SECONDS` 1–3 дня. **Не трогать код — он уже прав.**
- `CAMOUFOX_PROFILE_DIR` → encrypted/persist volume в prod (варнинг есть, действие — нет).
- `NODE_OPTIONS=--max-old-space-size≈1536` в `Dockerfile.backend` — полезно, т.к.
  контейнер уже 2G (а **не** потому что лимитов нет).
- **Пропустить:** добавление `deploy.limits` (есть) и allkeys-lru (есть).

### P0-новый — риск бана (в ресерче отсутствует, важнее RAM)

- **Residential proxy** на постинге — датацентр IP это killer #1.
- Убрать бурст-cron: рандомизированный джиттер, «прогрев» чтением ленты перед
  постингом, дневные капы ниже поведенческих порогов, warmup новых аккаунтов
  (частично есть — `WARMUP_DAYS_TOTAL`).
- **Не включать** `ENGAGEMENT_ENABLED` / `REPLIES_ENABLED` — AI-реплаи детектятся и
  душатся жёстче всего.

### P1 — стабилизация (настоящая ценность ресерча)

- Починить `generate()`: `AbortController` + запись/очистка `activeRuns`, иначе
  pause/resume на cron-прогонах фиктивен.
- Native-mem-pressure рестарт браузера (порог `RSS − heapUsed`) в дополнение к таймеру.
- Age-based retention в BullMQ (сейчас только по count).

### P2 — качество

- Калибровка judge по методу §2.3 (binary + kappa + few-shot), а не «собрать scores
  и подвигать порог».
- Заполнить `cost` и бюджет на run.
- Включить `LLM_ROLE_CHAINS` (сильные модели на draft/hook, дешёвые на judge) — рычаг
  уже в коде (`llm.service.ts:330`, `parseRoleChains`), просто не задействован.

---

## 4. Источники

**Код (v0.5.2):** `docker/docker-compose.prod.yml`, `infra/docker-compose.yml`,
`docker/Dockerfile.backend`, `packages/backend/src/infrastructure/browser/browser.factory.ts`,
`packages/backend/src/infrastructure/llm/llm.service.ts`,
`packages/backend/src/infrastructure/queue/queue.factory.ts`,
`packages/backend/src/modules/generation/generation.service.ts`,
`packages/backend/src/modules/generation/generation.graph.ts`,
`packages/backend/src/modules/generation/cron.service.ts`,
`packages/backend/src/modules/health-monitor/health-monitor.service.ts`,
`packages/backend/src/modules/posting/posting.service.ts`,
`packages/shared/src/types/domain.ts`, `.env.example`.

**Внешние (через EXA):**
- Camoufox memory leak: daijro/camoufox issues [#245](https://github.com/daijro/camoufox/issues/245),
  [#87](https://github.com/daijro/camoufox/issues/87), [#363](https://github.com/daijro/camoufox/issues/363);
  native-mem-pressure рестарт — jo-inc/camofox-browser commit 78f8f40.
- Ban/suspension: SocialNexis «X Automation Rules 2026», Sorsa «Error 226»,
  notpeople.ai «~2000 test accounts» study.
- LLM-as-judge калибровка: Evidently, Arize, Boundev, Galileo, aievals.co.
