# SPA Audit — Обзор и сводка (v0.5.1, июнь 2026)

> Аудит выполнен по запросу: оценить проектирование, реализацию, хрупкие места, безопасность,
> надёжность/анти-бан и конкурентов. **В отчётах описаны только проблемы, баги, риски и
> предложения.** То, что сделано хорошо, намеренно не описывается.
>
> Принцип проверки (из `CLAUDE.md`): **доверять исходнику, а не прозе доков.** Все находки
> привязаны к `file:line` и проверены по коду. Критичные пункты перепроверены вручную;
> часть находок в периферийных модулях получена через параллельный deep-read и помечена.

## Состав отчётов

| Файл | Тема |
|------|------|
| `01-architecture-and-anti-patterns.md` | Архитектурные ошибки проектирования, анти-паттерны, дрейф ADR↔код |
| `02-bug-report.md` | Конкретные баги с `file:line`, severity, impact, fix |
| `03-reliability-anti-ban.md` | Надёжность постинга, идемпотентность, риск банов, browser automation |
| `04-security.md` | Секреты, шифрование сессий, prompt injection, отсутствие auth |
| `05-features-and-competitors.md` | Конкуренты, official API vs browser automation, пробелы и предложения по фичам |
| `06-code-review-current-changes.md` | Ревью changeset'а: гигиена коммитов, миграции, тесты, что блокирует мёрдж |
| `07-code-review-findings.md` | Подтверждённые баги max-review текущих изменений: `file:line`, код, готовый fix |
| `08-BACKLOG.md` | Единый бэклог: оценки, майлстоуны, порядок исполнения, граф зависимостей |

## Методология

- **Прочитано вручную (первичная проверка):** `posting.service`, `base.poster`, `x.poster`,
  `browser.factory`, `queue.factory`, `rate-limit.service`, `encryption.service`, `localhost.guard`,
  `llm.service`, `env.validation`, `app.module`, `main.ts`, `auto-approve.listener`,
  `recycling.controller`, `schema.prisma`, фрагменты `generation.service`, `sessions.service`,
  `health-monitor.service`.
- **Параллельный deep-read (субагенты):** `engagement/*`, `replies/*`, `trending/*`,
  `content-enhancements/*`, `autonomy/*`, `analytics/*`, `quote-cards/*`, `posts/*`, UI (`ui/src/*`).
- **Внешний ресёрч (с источниками):** конкуренты (Buffer, Postiz, Mixpost, Typefully, Hypefury,
  Taplio…), official API vs stealth-automation, anti-detection (Camoufox/CDP/fingerprint), BullMQ
  идемпотентность, ban-практики X/Meta. Полные источники — в `05-…` и в `docs/audit/_research/`.

## Severity

- **Critical** — ломает основную функцию, ведёт к бану аккаунта, потере/дублю постов или утечке секретов.
- **High** — неверное поведение в штатной работе, серьёзный риск, скрытая деградация фичи.
- **Medium** — хрупкость, частичная неработоспособность, заметный долг.
- **Low** — качество, мелочи, косметика.

## Топ-проблемы (приоритет к исправлению)

### Стратегическое

**S1. Stealth browser-automation — осознанный выбор продукта. Ниже не «перейдите на API», а риск,
которым этот выбор нужно управлять.** Подход намеренный и местами безальтернативный: личный профиль
Facebook через API постить нельзя вообще. Но интенциональность не отменяет технический факт — для
X/Meta это нарушение ToS (X: «scripting the X website… may result in the **permanent suspension** of
your account»), то есть ban-риск реален. Вывод не «смените подход», а «раз выбран stealth — закалите
его»: верификация факта публикации, изоляция fingerprint/IP, человекоподобные лимиты — это и есть
содержание `03-reliability-anti-ban.md`. Решение команды: **постинг — stealth по всем сетям, official
API для записи не используем.** Бесплатные read/analytics-API (метрики Threads/FB-Page) допустимы для
аналитики; платные (X read) — пока нет. Стратегический приоритет — закалка stealth-обвязки (`03`).

### Critical (надёжность/безопасность)

1. **Авто-аппрув постит мимо всех проверок контента.** Активный путь (`AutoApproveListener`,
   `auto-approve.listener.ts:58-105`) проверяет только `qualityScore` и **не вызывает `AutoCheck`**
   (engagement-bait, char-limit, forbidden phrases, SimHash). Полный `AutoCheck` есть только во
   втором пути (`AutoApproveService`), который слушатель не использует. → `02`, `04`.
2. **Авто-аппрув «fail-open» при отсутствии оценки** (`auto-approve.listener.ts:77-81`): нет
   `qualityScore` → пост одобряется и публикуется. Сбой LLM = «постим всё». → `02`, `04`.
3. **Застрявшие посты в `POSTING` не восстанавливаются.** Краш во время постинга оставляет статус
   `POSTING` навсегда; health-monitor только считает их в алерте (`health-monitor.service.ts:308`),
   reconciliation чинит только `APPROVED` (`:81-140`). Guard `POSTING` блокирует повторную отправку →
   пост «потерян». → `03`.
4. **Детекция успеха постинга ненадёжна в обе стороны.** `validatePostOnProfile`
   (`base.poster.ts:155-225`) ищет первые 40 символов через `innerText.includes` → может пометить
   успешный пост как FAILED (ре-аппрув → дубль) или провалившийся как POSTED со ссылкой на старый
   твит. `verifyPostVisible`/`detectPostShadowban` используют `networkidle`, который на X/Threads
   «никогда не наступает» (по собственному комменту `base.poster.ts:163`). → `03`.
5. **`X-Forwarded-For` тривиально обходит единственный guard** опасных endpoint-ов
   (`localhost.guard.ts:53-55`): клиент шлёт `X-Forwarded-For: 127.0.0.1` и проходит. → `04`.
6. **Cookie Facebook лежат в открытом виде** в `/tmp/spa-profiles/facebook` (persistent
   `user_data_dir`), минуя AES-шифрование сессий — для FB шифрование сессий не работает вообще. → `04`.
7. **`engagement` рейт-лимит молча режет лайки до 1/день.** Ключи вида `"X-like"` не существуют в
   картах лимитов → дефолт `?? 1` (`rate-limit.service.ts:102`). Вся «человекоподобная» активность
   мертва. → `02`.
8. **`recycling` endpoint сломан**: `recyclePost(postId: string)` без `@Param`
   (`recycling.controller.ts:27`) → всегда `undefined`. → `02`.

### High (выборка; полный список в `02`/`03`/`04`)

- Авто-reply в `replies-monitor` спит `setTimeout` 5–30 мин **внутри** последовательного цикла крона,
  без re-entrancy guard (`replies-monitor.service.ts:117-134`).
- LLM-путь авто-reply обходит детерминированный фильтр чувствительных тем/жалоб
  (`replies-monitor.service.ts:511,521`) — brand-safety/harm-риск.
- `commentId` строится из обрезанного `[^a-zA-Z0-9]` текста → **кириллица коллапсирует**, реальные
  комментарии целевой аудитории дропаются как дубли (`replies-monitor.service.ts:271-274`).
- `withRetry`/self-recovery обёрнуты вокруг неидемпотентного постинга → риск дублей при неточной
  детекции успеха (`posting.service.ts:165,204-274`).
- Один Camoufox browser + один статический прокси на X и Threads → общий fingerprint/IP для разных
  аккаунтов (`browser.factory.ts:78-105,92`); ротации прокси нет, несмотря на флаг.
- Скриншоты `fullPage` пишутся на диск без очистки на каждом шаге постинга и **на каждой итерации
  скролла** в engagement → неограниченный disk-leak (`browser.factory.ts:500-518`, `base.engager.ts:117`).
- `process.on('uncaughtException')` логирует и **не выходит** (`main.ts:10-17`) — процесс продолжает
  работу в неопределённом состоянии.
- Два расходящихся пути авто-аппрува дают гонку/разные решения по `Post.status` (`02 A2/A4`).
- `approve()`/`reject()` без валидации перехода состояний — POSTED/FAILED/REJECTED можно
  ре-аппрувнуть (`posts.service.ts:123-145`).
- Quote-cards: Satori вызывается с `fonts: []` → всегда падает в catch, фича мертва (`02 E29`).
- `metrics-scraper` — вечная заглушка `return null` → «обучение на engagement» не работает (`02 D23`).

## Дрейф документации ↔ код (подтверждённый)

- README/CONSTITUTION: «OpenAI gpt-4o-mini + Ollama». Реально — **8-провайдерный** роутер,
  дефолт `gpt-5-nano` (`llm.service.ts:119-233`).
- ADR-003 «7-step graph» → реально per-network fan-out (`generation.graph.ts`).
- ADR-004 `IContentSourcePort` → реальный токен `IContentPort`; нет `IEngagementDecisionPort` в ADR.
- ADR-006 «threshold ≥8» → дефолт `AUTO_APPROVE_MIN_SCORE=7` (`env.validation.ts:80`).
- Комменты в `llm.service.ts:44-57` всё ещё описывают 6 провайдеров (нет Google/NVIDIA).
- `save_to_db` в графе — не пишет в БД (только формирует state); реальная запись + SimHash в
  `generation.service` после `graph.invoke()`.
- Цифры тестов в ROADMAP (458/375/368…) расходятся — реальное число берётся прогоном `pnpm test`.

> Вывод: документы — это «что собирались построить», а не «что построено». Любое утверждение из
> прозы доков нужно проверять `grep`-ом по исходнику.
