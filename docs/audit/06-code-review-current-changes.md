# 06 — Code Review: текущие незакоммиченные изменения

> Ревью **рабочего дерева** (uncommitted), а не отдельного PR. Срез на момент аудита.
> Снимок: `git diff` = **118 tracked-файлов, +13 381 / −2 307**, плюс десятки **untracked** новых
> модулей (autonomy, content-enhancements, replies, trending, quote-cards, flow-control, analytics,
> dry-run, captcha, proxy, crypto, guards…). Фактически это весь MVP, ещё не разложенный по коммитам.
>
> Содержательные баги не дублирую — они в `02`/`03`/`04`. Здесь — **взгляд на changeset**: что
> блокирует коммит/мёрдж, гигиена, схема/миграции, тесты, чеклист перед коммитом.
>
> На момент аудита actionable-пункты были сведены в теперь замороженный
> `08-BACKLOG.md`. Для новой работы воспроизведите находку и заведите canonical task в
> `docs/planning/BACKLOG.md` через `PLAN-005`.

## Вердикт: **changes requested**

Причина не в отдельной строке, а в трёх вещах: (1) изменения нельзя ревьюить как один блоб; (2) внутри
есть **Critical**, которые нельзя коммитить «как есть» в ветку, претендующую на автономный постинг;
(3) в трекинг попал генерируемый артефакт.

---

## P0 — процесс и scope (до содержания)

### CR-1. Один незакоммиченный блоб на 13k+ строк / ~160 файлов — **нереально ревьюить** — Blocking
Это не code review-able единица. Нет атомарных коммитов, нет истории «что зачем», `git bisect`
бесполезен, откатить частично нельзя. Перед любым мёрджем — разложить на логические коммиты
(Conventional Commits, как в истории репо): `feat(autonomy)…`, `feat(engagement)…`, `feat(replies)…`,
`fix(posting)…`, `chore(infra)…`, `test…`. Ориентир — по модулям/майлстоунам из `08-BACKLOG.md`.

### CR-2. В git-трекинг попал генерируемый артефакт — Blocking (гигиена)
`packages/ui/playwright-report/index.html` **отслеживается и изменён** (`git ls-files` его видит). Это
вывод Playwright-репортера, ему не место в репозитории.
**Fix:** `git rm --cached packages/ui/playwright-report -r` + добавить `packages/ui/playwright-report/`
в `.gitignore`.

### CR-3. Огромный diff `pnpm-lock.yaml` (+1421/−…) внутри того же блоба — Should-fix
Изменения лок-файла должны идти **отдельным** коммитом (`chore(deps): …`) с явным списком, что
добавилось (camoufox-js, satori, joi, ioredis, bullmq, langgraph…). Иначе ревью зависимостей
(лицензии/CVE) тонет в общем диффе. См. `dependency-audit` как отдельную задачу.

---

## Blocking — content (нельзя коммитить в авто-постящую ветку как есть)

Полное описание — в `02`/`04`; здесь — что именно в этом changeset обязано быть исправлено до того,
как ветка получит право на автономную отправку:

| ID | Файл (в диффе) | Почему blocking |
|----|----------------|-----------------|
| AU1/AU2 | `events/listeners/auto-approve.listener.ts` (untracked, new) | активный авто-аппрув обходит `AutoCheck` и fail-open при отсутствии score → «постим всё» |
| SEC1 | `infrastructure/guards/localhost.guard.ts` (untracked, new) | XFF обходит единственный guard опасных endpoint-ов |
| SEC2 | `infrastructure/browser/browser.factory.ts` (M, +331) | FB-cookie в плейнтексте в on-disk профиле, мимо crypto |
| P1 | `modules/posting/posters/base.poster.ts` (M, +320), `x.poster.ts` (M, +587) | детекция факта публикации даёт ложные POSTED/FAILED → дубли/потери |
| RC1 | `modules/recycling/*` (untracked, new) | endpoint `recyclePost` без `@Param` — мёртвый |
| R1 | `modules/rate-limit/rate-limit.service.ts` (M, +26) | engagement-лимит режет лайки до 1/день |

> Эти файлы — часть текущего диффа, так что «закоммитить changeset» = закоммитить и эти дефекты.
> Минимум: разнести так, чтобы автономные модули (autonomy/replies/engagement) шли **за флагом OFF**
> и отдельными коммитами, а критфиксы (M0 из backlog) — впереди них.

---

## Should-fix в этом changeset (High)

- `main.ts` (+11): добавлен `process.on('uncaughtException')`, который **глушит и продолжает** — см.
  `04 SEC4`. Раз это новый код в диффе — поправить сразу (graceful shutdown + `unhandledRejection`).
- `infrastructure/queue/queue.factory.ts` (+66): `removeOnComplete:{count:100}` — поверхностная
  идемпотентность (`02 P4`); как минимум задокументировать, что реальная защита — статус-машина.
- `infrastructure/sse/sse.service.ts` (+80): backpressure-листенеры/таймеры без дедупа (`02 UI3`).
- `modules/posting/posting.service.ts` (+349): мёртвый `withRetry` + self-recovery, повторяющий
  постинг (`03 §1`). Большой прирост — ревьюить отдельным коммитом с тестом на «не дублит».
- `generation.graph.ts` (+716) и `generation.service.ts` (+925): крупнейшие приросты в диффе,
  заявлены как один кусок — обязательно бить на коммиты (graph fan-out, dedup, threads, brand-voice).

---

## Схема и миграции

5 новых миграций (untracked), все **аддитивные** — это правильно:
`add_paused_run_status`, `add_post_metrics`, `add_simhash_to_post`, `add_thread_progress`,
`add_incoming_comments`. Префиксы по дате, порядок монотонный.

Проверить перед коммитом:
- Каждая колонка/таблица — nullable или с default (data-safe). `Post.simhash` — nullable ✓; новые
  таблицы (`PostMetrics`, `ThreadProgress`, `IncomingComment`) — аддитивны ✓.
- `add_paused_run_status` добавляет значение enum `GenerationRunStatus` — в Postgres `ALTER TYPE …
  ADD VALUE` **нельзя откатить** и нельзя в одной транзакции с использованием значения; Prisma это
  обычно разруливает, но down-rollback enum невозможен — зафиксировать в `runbooks/rollback.md`.
- Убедиться, что миграции **сгенерированы** `prisma migrate`, а не правлены руками (рассинхрон с
  `schema.prisma` +78 строк ловится `prisma migrate diff`).
- Миграции `?? untracked` → закоммитить **вместе** со `schema.prisma`-изменением, одним коммитом
  `feat(db): …`, иначе на чужой машине `migrate deploy` разъедется со схемой.

---

## Тесты

- Прирост тестов огромный (`sessions.service.spec.ts` +1519, `posting.service.spec.ts` +469, …) —
  это плюс, но **браузер замокан** → зелёный прогон **не** доказывает рабочий постинг (`01 D1`).
  Нужен dry-run против реального DOM хотя бы nightly.
- `tests/helpers/sprint-o-paramtypes.ts` (untracked, new) — ручное восстановление DI-метаданных после
  esbuild (`01 D3`). Это коупит хрупкость: добавишь инжектируемого — full-app тесты падают. Отметить в
  README тестов как обязательный шаг при смене конструкторов.
- Диагностические специи `test-config-diag.spec.ts`, `test-queue-diag.spec.ts` (untracked) — похоже на
  отладочные; убрать из коммита или перенести в `__diagnostics__`, чтобы не шумели в CI.
- `tests/setup.ts` мутирует глобальный `process.env` при single-thread vitest — тесты не изолированы
  (`01 D2`); не наращивать на этом фундаменте без осознания.

---

## Гигиена коммита (прочее)

- `.gitignore` (+9) — добавлены `.serena/`, `graphify-out/`, `.env.bak`, `.env.before*` — **хорошо**;
  убедиться, что `.env.bak`/`.env.before-reserve` (лежат в корне) не были закоммичены ранее
  (`git log --all -- .env.bak`).
- `.env.example` (+92) — проверено: **реальных секретов нет**, только дефолты/плейсхолдеры ✓. Новые
  ключи (`AUTONOMOUS_*`, `AUTO_APPROVE_*`, `ENGAGEMENT_*`) — задокументированы инлайн ✓.
- `packages/ui/postcss.config.js` **удалён**, изменены `tailwind.config.ts`/`vite.config.ts` — похоже
  на миграцию Tailwind v4 (PostCSS-конфиг не нужен). Подтвердить намеренность одним коммитом
  `chore(ui): tailwind v4`.
- `CLAUDE.md`, `docs/ARCHITECTURE_AUDIT_*`, `docs/adr/ADR-006`, `docs/audit/` — untracked доки; решить,
  что из них коммитить (ADR-006 и audit — да; временные — нет).

---

## Чеклист перед коммитом (actionable)

1. `git rm --cached packages/ui/playwright-report -r` + gitignore (CR-2).
2. Разнести блоб на коммиты по модулям/майлстоунам; автономные модули — отдельно и за флагом OFF (CR-1).
3. Лок-файл — отдельным `chore(deps)` (CR-3).
4. Внести M0-критфиксы (`08-BACKLOG.md`): RC1, R1, AU1/AU2, SEC1, P7, B5/SEC4, PO1 — **до** коммита
   автономных модулей.
5. Миграции + `schema.prisma` — одним `feat(db)`-коммитом; rollback-ограничение по enum — в runbook.
6. Убрать `*-diag.spec.ts` из коммита.
7. `pnpm lint && pnpm test && pnpm test:coverage` зелёные; затем **`pnpm dry-run`** против живых
   страниц — единственная проверка, что постинг реально работает.
8. Не включать `AUTO_APPROVE_ENABLED`/`AUTONOMOUS_RUNNER_ENABLED` до конца M1 (exactly-once).
