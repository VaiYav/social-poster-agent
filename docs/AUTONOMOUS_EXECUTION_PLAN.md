# Autonomous Execution Plan — Social Poster Agent

> План для автономного агента, который добивает весь запланированный скоуп SPA поэтапно, с остановками на code review, тесты, исправления багов и doc sync.  
> Стартовая точка: ветка `f4-adaptive-replies` (PR #55).  
> Определение "done": backend + UI + тесты + docs.  
> Режим: автопилот — агент сам создаёт ветки, коммитит, пушит и мержит, если локальные чеки зелёные. Обязательный человек в цикле: реальные credentials, биллинг CI, деструктивные операции, архитектурно неоднозначные решения.

---

## 1. Контекст и ограничения

### 1.1 Источник правды
- **Код превыше документов.** `ROADMAP.md`, `CONSTITUTION.md`, `FEATURE_WISHLIST.md` — намерения, часто устаревшие. Решающий источник — `packages/backend/src/` и `packages/ui/src/`.
- Текущий скоуп в `FEATURE_WISHLIST.md` (F1–F22) плюс `B1–B10` и `D*` баги.

### 1.2 Автономные границы
- Можно: создавать/переключать feature-ветки, коммитить, пушить, открывать PR, мержить, если зелёно.
- Нельзя без явного подтверждения пользователя:
  - разливать real credentials в `.env` и запускать live-постинг (`pnpm live`);
  - менять биллинг/CI/репо-настройки;
  - `rm -rf`, `drop table`, `git push --force`, `git rebase -i` over shared history;
  - делать `release`/`deploy` в продакшен.

### 1.3 Целевые чеки после каждого спринта
1. `cd packages/backend && npx tsc --noEmit`
2. `pnpm build:backend`
3. `pnpm --filter @spa/ui build`
4. `pnpm lint` (0 errors, 0 warnings)
5. `cd packages/backend && npx vitest run` (all pass)
6. `pnpm test:coverage` (thresholds: statements/functions/lines 80, branches 75)
7. `git diff --stat` + `git status` sanity check

Если любой из чеков падает — агент **останавливается**, дебажит, фиксит, перезапускает. Если не получается за N=3 итерации — эскалация пользователю.

---

## 2. Execution Engine (алгоритм автономного агента)

```
WHILE remaining_sprints > 0:
  PICK next sprint from backlog (top of plan)
  CREATE branch: feat/<phase>-<feature>-<shortname> from base branch
  REPEAT:
    IMPLEMENT backend (DDD, ports/adapters, feature-flag if needed)
    IMPLEMENT UI (Vue 3 view/components, Pinia store if needed)
    WRITE tests (unit → integration → system/acceptance)
    RUN local validation pipeline (tsc, build, lint, vitest, coverage)
    SELF-CODE-REVIEW (чеклист §3)
    FIX findings / test failures / lint / tsc
  UNTIL all checks green AND self-review clean
  COMMIT with conventional message (focus on "why", not "what")
  PUSH branch
  OPEN or UPDATE PR to base branch
  IF base branch green AND no destructive changes:
    MERGE (squash/merge as repo convention)
    UPDATE base branch
  ELSE:
    STOP and ASK user
  SYNC docs (ROADMAP, CONSTITUTION, FEATURE_WISHLIST, ADR, runbook, .env.example)
  RUN GATE review (чеклист §4)
  NEXT sprint
```

### 2.1 Состояние агента
Файл состояния: `.devin/autonomy/state.json`:
```json
{
  "current_phase": "phase-0",
  "current_sprint": "f4-notification-scraping",
  "base_branch": "f4-adaptive-replies",
  "active_branches": [],
  "completed_sprints": [],
  "blockers": [],
  "last_green_commit": "sha"
}
```
Агент обновляет этот файл после каждого коммита/мержа/блокера.

### 2.2 Branching
- `main` — production-ready.
- `f4-adaptive-replies` — интеграционная ветка текущей фазы (PR #55).
- `feat/phase-X-<id>-<name>` — ветка спринта.
- `fix/<phase>-<desc>` — hotfix-ветки, если regression.

После каждого merge в `f4-adaptive-replies` — перебазирование следующих спринтов.

---

## 3. Self-Code-Review Checklist

Перед коммитом/мержем агент должен сам ответить на каждый пункт:

### 3.1 Типы и безопасность
- [ ] Нет `any` без обоснования (`.oxlintrc.json` override для tests/scripts разрешён).
- [ ] Все `@Inject(TOKEN)` на месте, `design:paramtypes` восстановлены в `tests/helpers/restore-paramtypes.ts`.
- [ ] Нет хардкода secrets/credentials.
- [ ] Feature-flag env var добавлен в `env.validation.ts` и `.env.example`.
- [ ] Новые prompts Langfuse добавлены в `scripts/migrate-prompts-to-langfuse.ts`.

### 3.2 Архитектура
- [ ] Новый сервис зависит от портов, не от конкретных классов.
- [ ] Модуль условно регистрируется в `app.module.ts` через `process.env` чтение (см. `AGENTS.md`).
- [ ] Controller/Swagger decorators добавлены для новых endpoints.
- [ ] UI view добавлен в `router`, Pinia store вызовы через `useApi`.

### 3.3 Тесты
- [ ] Unit tests для новых чистых функций/сервисов.
- [ ] Integration tests для module/DB/Redis.
- [ ] System tests для REST контракта.
- [ ] Acceptance tests, если есть BDD-сценарий.
- [ ] Покрытие не падает ниже threshold.

### 3.4 Docs
- [ ] `ROADMAP.md` checkboxes и даты обновлены.
- [ ] `CONSTITUTION.md` § (feature section) синхронизирован.
- [ ] `FEATURE_WISHLIST.md` статус обновлён.
- [ ] ADR написан/обновлён, если архитектурное решение.
- [ ] `.env.example` актуален.

---

## 4. Gate Protocol (контрольные точки)

Каждый `GATE` — hard stop. Агент выполняет:

1. Полный прогон: `tsc`, `build:backend`, `ui build`, `lint`, `vitest run`, `test:coverage`.
2. Сравнение diff `main...HEAD` с планом.
3. Self-code-review (§3).
4. Обновление `state.json`.
5. **Если всё зелёно** — merge/continue.
6. **Если нет** — фикс внутри спринта; если за 3 попытки не получилось — `STOP`, запросить human.

---

## 5. Phases & Sprints

### PHASE 0 — Закрыть F4 (Adaptive Replies)
> Цель: довести F4 до done (backend + UI + tests + docs) и смёржить PR #55.

#### Sprint 0.1: F4 Notification Scraping
- Реализовать `x-notifications.scraper.ts`, `threads-notifications.scraper.ts`, `facebook-notifications.scraper.ts`.
- Добавить единый `NotificationScraper` порт/адаптер, внедрить в `RepliesMonitorService`.
- Тесты: unit + integration (mocked browser).

#### Sprint 0.2: F4 UI
- Создать `Replies.vue` (pending comments, manual reply, dismiss, human-review queue).
- Pinia store `replies.ts` + SSE wiring (`reply_posted`, `reply_failed`, `human_review`).
- Тесты: UI unit (vitest), e2e если есть infra.

#### Sprint 0.3: F4 Swagger + ADR
- Добавить `@ApiOperation`/`@ApiResponse` в `RepliesController`.
- Написать `docs/adr/ADR-007-adaptive-replies.md`.

#### Sprint 0.4: F4 Coverage & System Tests
- Добить `test:coverage` > thresholds.
- Добавить system/acceptance сценарии для replies API.

**GATE 0:** все F4 чеки зелёные, PR #55 approved, merge в main.

---

### PHASE 1 — F2 / F3 / F10 / F22 (Phase 1.5)
> Цель: дореализовать частично готовые фичи; всё фича-флагами.

#### Sprint 1.1: F2 Multi-Stage Posting ✅
- Root post is marked `multiStage=true` + `threadDepth` in `llmMetadata`; continuation posts are scheduled 30 min apart via `THREAD_CONTINUATION_DELAY_MS`.
- `PostingService.postById()` posts only the root for multi-stage threads, then schedules the next approved continuation; continuations reply to the root thread.
- `XPoster.postThreadReply()` and `ThreadsPoster.postThreadReply()` handle single continuation replies.
- UI badge added to `PostCard.vue` for multi-stage threads.
- Unit tests: F2-001..F2-006 in `posting.service.spec.ts`.

#### Sprint 1.2: F3 On-Demand Model Picker ✅
- UI dropdown в `Generate.vue` (cloud vs Ollama models).
- Протащить model choice в `GenerationService` → `LlmService`.
- Feature flag `MODEL_PICKER_ENABLED`.

#### Sprint 1.3: F10 Content Repurposing (deep fact extraction) ✅
- `ContentReader` extracts facts from frontmatter (`answerCapsule.keyPoints`, `answer`) and article body (bullet/numbered lists, H2/H3 headings, `**bold**` phrases, first sentence of each paragraph).
- `ArticleFrontmatterSchema` accepts comma-separated `tags` / `keyPoints` and a plain string `answerCapsule`.
- Added `extract-facts.ts` helper and `extract-facts.spec.ts` / updated `content-reader.spec.ts` (F10-001..F10-012, UTC-484).

#### Sprint 1.4: F22 Trending API Integration ✅
- `TrendingScraperService` supports Google Trends RSS + programmatic API proxy with RSS fallback; `TRENDING_GOOGLE_API_URL` + `TRENDING_GOOGLE_API_KEY` env gate.
- X Trends browser scrape has multi-URL/multi-selector fallback and niche relevance LLM filter.
- UI: `Dashboard.vue` Trending Snapshot renders merged (Google/X/Astro) trends with source labels and priority; `Trending.vue` correctly displays `sources` and `priority`.
- Unit tests: `trending-scraper.spec.ts` (24), `google-trends-rss.spec.ts` (7).

**GATE 1:** 4 спринта в main, `ROADMAP.md` Phase 1.5 = 100%.

---

### PHASE 2 — F1 Autonomous User-Agent (unfreeze)
> Цель: вынуть `EngagementModule` из-за флага `ENGAGEMENT_ENABLED=false`.

#### Sprint 2.1: F1 Decision Engine ✅
- `generateComment` / `generateQuoteText` реализованы через `EngagementDecisionService` с brand-voice + языковыми guardrail.
- `IEngagementDecisionPort` + LLM-based decision graph (individual + batch) + `HumanBehaviorEngine` интегрированы.
- Discussion budget (repost + quote) + F1 limits: 20 likes / 5 comments / 2 discussions в день (per-session 4/1/2, clamped to global).
- Swagger decorators добавлены в `EngagementController`.
- Unit tests: 161+ тестов в `tests/unit/engagement/`.

#### Sprint 2.2: F1 Targeting
- Хэштеги/конкуренты/algorithmic feed selectors.
- Rate-limit safety (strict, below radar).

#### Sprint 2.3: F1 UI Control Panel
- `AutonomousAgent.vue` view: start/pause/status/network selector.
- Real-time status через SSE.

#### Sprint 2.4: F1 Safety & Tests
- Ban-risk guardrails.
- Unit/integration tests для engager + decision engine.
- ADR/Runbook.

**GATE 2:** F1 можно запускать через UI, тесты покрыты.

---

### PHASE 3 — F8 A/B Testing
> Цель: система A/B для постов.

#### Sprint 3.1: Variant Generation
- LangGraph node `ab_variant` (уже partial) доделать.
- Сохранять `abVariant` в `Post.llmMetadata`.

#### Sprint 3.2: Analytics Comparison
- Метрики в `AnalyticsService` с разбивкой по variant.
- Endpoint `GET /analytics/ab-test/:postId`.

#### Sprint 3.3: UI A/B Results
- Компонент/вкладка в `Dashboard.vue` или `History.vue`.

**GATE 3:** A/B тест создаётся, сравнивается, показывается в UI.

---

### PHASE 4 — Release Readiness (Phase 6)
> Цель: production-ready, manual E2E, финальная документация.

#### Sprint 4.1: Manual E2E with Real Credentials
- **HUMAN-ONLY.**
- Подготовить `.env` с реальными `SOCIAL_X_*`, LLM key.
- Запустить `pnpm dry-run`, затем `pnpm --filter @spa/backend live`.
- Зафиксировать результаты в `docs/runbook-real-posting-e2e.md`.

#### Sprint 4.2: Runbooks & Sentry
- Runbook для replies/engagement/A/B.
- Sentry tags/alerts донастроить.
- Docker prod + nginx sanity.

#### Sprint 4.3: UI Polish
- Responsive/mobile (P2).
- Dark mode (P2, optional).

#### Sprint 4.4: Final Coverage & Lint
- `pnpm test:coverage` > thresholds.
- `pnpm lint` 0/0.
- `tsc`/`build` green.

**GATE 4 (FINAL):** release ready.

---

## 6. Known Blockers

| Блокер | Влияние | Митигация |
|---|---|---|
| Manual E2E with real credentials | Нельзя автоматизировать | Human gate, runbook |
| GitHub Actions billing / Vercel Hobby | CI/deployment не работает | Локальная валидация, manual merge, billing fix |
| Facebook UI fragility | Бан/ломающиеся selectors | Page Object, feature flag, selector-health |
| Ollama для F1/F3 | Требует GPU/local model | Fallback на cloud, env-gate |
| Content-agent-platform factbase | F4 factual grounding | MVP keyword search, Phase 2 embeddings |

---

## 7. Definition of Done (общий)

Каждый спринт считается done только если:
1. Код реализован backend + UI (если применимо).
2. `npx tsc --noEmit` green.
3. `pnpm build:backend` green.
4. `pnpm --filter @spa/ui build` green (если UI touched).
5. `pnpm lint` 0 errors, 0 warnings.
6. `npx vitest run` 100% pass.
7. `pnpm test:coverage` thresholds met.
8. Tests написаны для новой функциональности.
9. Docs/ADR/runbook обновлены.
10. `state.json` обновлён, PR/merge done.

---

## 8. Первый шаг (что делать прямо сейчас)

1. Убедиться, что `f4-adaptive-replies` зелёная (уже done: 1748 tests, lint 0/0).
2. Создать `feat/phase-0-f4-notification-scraping` от `f4-adaptive-replies`.
3. Реализовать notification scraping для X/Threads/FB.
4. Прогнать validation pipeline.
5. Self-review → commit → push → PR → merge → обновить `state.json`.

---

## 9. Notes

- Все feature-flags читаются в `process.env` на этапе `app.module.ts` (не `ConfigService`), см. `AGENTS.md` § Orchestrator.
- `.js` extensions в `orchestrator/` модулях — обязательно.
- Каждое изменение конструктора сервиса требует обновления `tests/helpers/restore-paramtypes.ts`.
