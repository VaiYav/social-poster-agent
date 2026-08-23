# 07 — Code Review: подтверждённые баги (max-review текущих изменений)

> Детальный per-bug отчёт max-effort code-review воркфлоу по **незакоммиченным изменениям** рабочего
> дерева (ветка `fix/a3-remaining-tests`, 202 изменённых файла, июнь 2026). В отличие от `06`
> (changeset-гигиена/процесс) — здесь конкретные баги с точным `file:line`, фрагментом кода и готовым
> fix'ом. В отличие от `02` (общий bug-report v0.5.1) — скоуп ограничен текущим диффом `git diff HEAD`.
>
> **Связь с остальным аудитом.** Часть находок подтверждает уже известное: SEC-1 ↔ `04` (XFF guard),
> BUG-4 ↔ `02 P1` (детекция постинга), BUG-3 ↔ `02 R1` (engagement rate-limit). Остальные —
> **новые** для текущего changeset (simhash само-матч, остановка планировщика вовлечения, домен
> Threads-куки, затирание `llmMetadata`, hang `/health`, `pendingWrites`, `maxTokens`…). Actionable-пункты
> на момент аудита были сведены в теперь замороженный `08-BACKLOG.md`. Новая работа
> создаётся только после воспроизведения через `PLAN-005` в canonical backlog.

## Методология и пометка проверки

Находки получены воркфлоу: 10 finder-углов → независимый верификатор на каждую находку → отчёт с капом
(15 из 47 подтверждённых, по severity). Затем каждая подтверждённая находка **дообогащена отдельным
агентом**: чтение текущего файла рабочего дерева, точный фрагмент-нарушитель, конкретный fix с before/after
и заметкой по тесту.

Пометка: **[CR-V]** — подтверждено независимым верификатором обзора и перепроверено по исходнику при
дообогащении (фрагменты кода ниже скопированы из файла, не пересказаны). Принцип прежний (из `CLAUDE.md`):
**доверять исходнику, а не прозе доков.**

## Severity

- **Critical** — ломает основную функцию, ведёт к бану аккаунта, потере/дублю постов или обходу защиты.
- **High** — неверное поведение в штатной работе, серьёзный риск, скрытая деградация фичи.
- **Medium** — хрупкость, частичная неработоспособность, заметный долг.
- **Low** — качество, мелочи, косметика.

## Сводка (триаж)

| ID | Severity | Файл | Суть |
|----|----------|------|------|
| **SEC-1** | Critical | `localhost.guard.ts:54` | Обход guard через подделку `X-Forwarded-For: 127.0.0.1` |
| **BUG-1** | Critical | `auto-check.service.ts:112` | Авто-аппрув реджектит 100% своих постов (simhash само-матч) |
| **SEC-2** | High | `localhost.guard.ts:46` | `startsWith('172.2')` пускает публичные IP как «внутренние» |
| **BUG-2** | High | `engagement-scheduler.service.ts:59` | Вовлечение встаёт навсегда после стартового дня |
| **BUG-3** | High | `human-behavior-engine.ts:267` | Лимит вовлечения по факту 1 лайк + 1 коммент в день на сеть |
| **BUG-4** | High | `base.poster.ts:183` | Верификация постинга даёт ложный POSTED |
| **BUG-5** | High | `sessions.service.ts:312` | Threads-куки на `.threads.net`, проверка на `threads.com` → cookie-auth не работает |
| **BUG-6** | High | `x.poster.ts:167` | Тред через home-page fallback теряет все ответы |
| **BUG-7** | High | `auto-approve.service.ts:125` | `makeDecision` затирает весь `llmMetadata` (hook/qualityScore/visualConcept…) |
| **BUG-8** | High | `health.controller.ts:35` | `/health` зависает при недоступном Redis → рестарт пода |
| **BUG-9** | Medium | `redis-checkpoint.ts:84` | Resume не восстанавливает `pendingWrites` → повтор уже выполненных нод |
| **BUG-10** | Medium | `engagement-scheduler.service.ts:141` | Невалидное окно (`NaN`) рушит весь тик планирования |
| **BUG-11** | Medium | `queue.factory.ts:41` | `BULLMQ_MAX_RETRIES=0` молча превращается в 3 |
| **BUG-12** | Medium | `auto-approve.service.ts:91` | Полоса HUMAN_REVIEW недостижима при дефолтных порогах |
| **BUG-13** | Medium | `llm.service.ts:245` | `GenerateOptions.maxTokens` молча игнорируется адаптером |

Итог: **2 Critical, 8 High, 5 Medium.** Ниже порога отчёта обзор отметил ещё ~32 низкоприоритетных
пункта (DRY/perf/dead-code) — кратко в конце документа.

---

## Безопасность / Guards

### SEC-1. Обход localhost-guard подделкой `X-Forwarded-For` — **Critical** [CR-V]
`packages/backend/src/infrastructure/guards/localhost.guard.ts:54`

**Суть.** `LocalhostGuard` доверяет первому (полностью контролируемому атакующим) элементу заголовка
`X-Forwarded-For`. К моменту этой ветки запрос **уже не прошёл** allow-list по loopback (`:41`) и по
Docker-сети (`:44-49`), то есть реальный TCP-пир — недоверенный, и перед соединением нет прокси, которому
guard мог бы верить. `forwardedFor.split(',')[0]` берёт самый левый, клиентский токен; nginx же через
`$proxy_add_x_forwarded_for` (`docker/nginx.conf:35`) **дописывает** реальный адрес справа — доверенный
токен всегда крайний правый, никогда `[0]`. Легитимный трафик до этой ветки вообще не доходит.

```ts
// When behind nginx, check X-Forwarded-For (nginx sets this to the real client)
// If XFF is present and is localhost, allow (nginx on same host)
if (forwardedFor) {
  const firstIp = forwardedFor.split(',')[0]?.trim() ?? '';
  if (allowedRemote.includes(firstIp)) return true;   // <-- spoofable
}
```

**Impact.** Полный обход единственного контроля доступа к опасным эндпоинтам: `POST /api/trending/scrape`
(браузерный скрейп X-трендов), `POST /api/recycling/run` (батч-записи в БД), `POST /api/quote-cards`
(генерация изображений + запись на диск). Порт `3100` публикуется на хост (`docker-compose.prod.yml:98-99`),
`trust proxy` в `main.ts` не задан. Любой удалённый вызов с заголовком `X-Forwarded-For: 127.0.0.1`
получает доступ → DoS/исчерпание пула Camoufox-сессий, повторный скрейп X (вектор бана), несанкционированные
записи.

**Fix.** Удалить XFF-ветку целиком (а не «парсить правильнее»): достижение этого кода уже доказывает, что
пир недоверенный, поэтому никакое значение клиентского заголовка не должно давать доступ. Легитимный путь
не страдает — nginx-трафик виден как Docker-сеть (172.x, `:44-49`), хост-loopback — `:41`. Заодно убрать
неиспользуемую `const forwardedFor` (`:37`) и поправить doc-комментарий класса (`:9-11`). Если в будущем
понадобится прокси — делать это через `app.set('trust proxy', <CIDR>)` и `req.ip`, а не ручным разбором.

```ts
// 1) убрать чтение заголовка (было :37)
-    const forwardedFor = request.headers['x-forwarded-for'] as string | undefined;

// 2) убрать спуфабельную ветку (было :51-56) — управление просто проваливается в warn + throw
-    if (forwardedFor) {
-      const firstIp = forwardedFor.split(',')[0]?.trim() ?? '';
-      if (allowedRemote.includes(firstIp)) return true;
-    }
     this.logger.warn(`Blocked non-localhost access ... from ${remoteAddress}`);
     throw new ForbiddenException('This endpoint is only accessible from localhost');
```

**Тест.** Юнит на guard напрямую. Важно: guard делает `return true` при `NODE_ENV === 'test'` (`:32`) —
в тесте надо подменить `process.env.NODE_ENV` на `'production'`, иначе проверка тривиально проходит.
Кейс: `remoteAddress:'203.0.113.5'` + `x-forwarded-for:'127.0.0.1'` → ожидать `ForbiddenException`
(сейчас возвращает `true`). Позитивный кейс: `'172.18.0.5'` без XFF → `true`.

### SEC-2. Слишком широкий префикс Docker-сети `startsWith('172.2')` — **High** [CR-V]
`packages/backend/src/infrastructure/guards/localhost.guard.ts:46`

**Суть.** Приватный диапазон `172.16.0.0/12` (172.16–172.31) проверяется перечислением строковых префиксов,
но под-диапазон 20–29 задан голым `startsWith('172.2')` — без точки и числовой границы. Текстово он матчит
весь публичный блок `172.2.0.0/16` (напр. `172.2.3.4`) **и** `172.200.x–172.255.x` (напр. `172.200.50.50`,
`172.255.1.1`). Всё от `172.32` вверх — публичное пространство. `remoteAddress` берётся прямо из TCP-пира
(`:36`), то есть префикс напрямую решает, кому доверять.

```ts
// Allow Docker internal network (172.16.0.0/12) — the UI container calls backend
if (remoteAddress.startsWith('172.16.') || remoteAddress.startsWith('172.17.') ||
    remoteAddress.startsWith('172.18.') || remoteAddress.startsWith('172.19.') ||
    remoteAddress.startsWith('172.2')   || remoteAddress.startsWith('172.30.') ||  // <-- too broad
    remoteAddress.startsWith('172.31.')) {
  return true;
}
```

**Impact.** Клиент с любого публичного адреса с префиксом `172.2` (весь `172.2.0.0/16` и
`172.200.0.0–172.255.255.255`) считается доверенным Docker-трафиком и обходит guard на тех же опасных
эндпоинтах (см. SEC-1).

**Fix.** Заменить хрупкое перечисление одной числовой проверкой второго октета (16–31 = ровно
`172.16.0.0/12`), плюс нормализовать IPv4-mapped IPv6 (`::ffff:172.x`).

```ts
if (this.isDockerPrivate172(remoteAddress)) {
  return true;
}

/** True только для 172.16.0.0/12 (172.16.0.0 – 172.31.255.255). Учитывает ::ffff:172.x. */
private isDockerPrivate172(address: string): boolean {
  const ipv4 = address.replace(/^::ffff:/i, '');
  const match = /^172\.(\d{1,3})\./.exec(ipv4);
  if (!match) return false;
  const secondOctet = Number(match[1]);
  return secondOctet >= 16 && secondOctet <= 31;
}
```

**Тест.** `'172.2.3.4'`, `'172.200.50.50'`, `'172.255.1.1'`, `'172.32.0.1'`, `'172.15.0.1'` → throw;
`'172.16.0.1'`, `'172.20.0.5'`, `'172.31.255.254'`, `'::ffff:172.18.0.5'` → `true`. (Снова подменить
`NODE_ENV`.)

---

## Autonomy (авто-аппрув)

### BUG-1. Авто-аппрув реджектит 100% своих постов (simhash само-матч) — **Critical** [CR-V]
`packages/backend/src/modules/autonomy/auto-check.service.ts:112`

**Суть.** Пост-сейв dedup в `AutoCheckService` не исключает сам кандидат. Кандидат уже сохранён как DRAFT
со своим `Post.simhash` (`generation.service.ts:558`), а `loadRecentHashes(network)` (`:146-161`) выбирает
все посты сети за 30 дней с `simhash != null` (или `POSTED`) **без** фильтра `id != candidate`. Своя строка
попадает в корпус, `hammingDistance(h, h) === 0 <= SIMHASH_THRESHOLD(3)`, `isDup` всегда `true`,
`simhash_dedup` падает, и `auto-approve.service.ts:71-74` возвращает REJECT независимо от score. B5-dedup
генерации (`generation.service.ts:537-548`) этой проблемы не имеет только потому, что выполняется **до**
сохранения; пост-сейв ре-чек потерял эту гарантию и не добавил исключение по id.

```ts
const candidateHash = simhash(content);
const recentHashes = await this.loadRecentHashes(network);              // включает сам кандидат
const isDup = recentHashes.some((h) => hammingDistance(candidateHash, h) <= SIMHASH_THRESHOLD);
// ...
private async loadRecentHashes(network: SocialNetwork): Promise<string[]> {
  const posts = await this.prisma.post.findMany({
    where: { network, createdAt: { gte: since },
      OR: [{ simhash: { not: null } }, { status: 'POSTED' }] },   // нет id: { not: candidate }
    select: { simhash: true, content: true }, take: 200,
  });
  ...
}
```

**Impact.** При `AUTO_APPROVE_ENABLED=true` гейт автономии (ADR-006, замена ручному HITL) реджектит **все**
сгенерированные посты; контента публикуется ноль, без ошибок. Плюс на каждом цикле срабатывает
`checkRejectStreak` → ложные health-алерты в Discord/SSE.

**Fix.** Прокинуть `postId` (он уже есть в `evaluate`) в `check()` → `loadRecentHashes()` и добавить
`id: { not: excludePostId }`. Кросс-постовый дедуп остаётся целым (исключается только одна строка кандидата).

```ts
// auto-approve.service.ts:68
- const checkResult = await this.autoCheck.check(content, network, qualityScore);
+ const checkResult = await this.autoCheck.check(content, network, qualityScore, postId);

// auto-check.service.ts: check(...) + loadRecentHashes(...) принимают excludePostId
  where: {
    network, createdAt: { gte: since },
+   ...(excludePostId ? { id: { not: excludePostId } } : {}),
    OR: [{ simhash: { not: null } }, { status: 'POSTED' }],
  },
```

**Тест.** Засидить ровно один DRAFT с content+simhash, вызвать `evaluate(thatId, C, network, score=9)` →
ожидать AUTO_APPROVE (сейчас REJECT с `simhash_dedup`). Второй кейс: засидить *другой* near-duplicate →
кандидат всё ещё реджектится (дедуп работает).

### BUG-7. `makeDecision` затирает весь `llmMetadata` — **High** [CR-V]
`packages/backend/src/modules/autonomy/auto-approve.service.ts:125`

**Суть.** Обновление пишет в `llmMetadata` голый литерал `{ autoApproveDecision, autoApproveReason,
autoCheckChecks }`. Prisma пишет JSON-колонку **полной заменой**, а не deep-merge, и прежнего чтения колонки
нет — поэтому затираются `qualityScore`, `hook`, `hookTechnique`, `contentStyleId`, `simhash`,
`visualConcept`, `abVariants` и пр., записанные `generation.service.ts:564-575`. `makeDecision` вызывается
для **всех** исходов (`AUTO_APPROVE`/`HUMAN_REVIEW`/`REJECT`). Корректный паттерн уже есть в репозитории —
`replies.service.ts:191` и `recycling.service.ts:67` читают и спредят `...existing`; этот вызов — выпадающий.

```ts
await this.prisma.post.update({
  where: { id: postId },
  data: {
    status: newStatus,
    llmMetadata: {                       // полная замена → потеря всех прочих ключей
      autoApproveDecision: decision,
      autoApproveReason: reason,
      autoCheckChecks: checkResult.checks.map((c) => ({ name: c.name, passed: c.passed, reason: c.reason })),
    },
  },
});
```

**Impact.** Тихое уничтожение данных на happy-path: `hook-performance-bank.ts:173` (`if (!metadata?.hook)
continue;`) молча пропускает эти посты → ломается обучение по hook-техникам; постер теряет `visualConcept`
(нет картинки); дашборды теряют `qualityScore`; ломается A/B-трекинг (`abVariants`).

**Fix.** Прочитать текущий `llmMetadata` и спредить его (как в `replies.service.ts`).

```ts
const existingPost = await this.prisma.post.findUnique({
  where: { id: postId }, select: { llmMetadata: true },
});
const existingMetadata = (existingPost?.llmMetadata as Record<string, unknown> | null) ?? {};

await this.prisma.post.update({
  where: { id: postId },
  data: {
    status: newStatus,
    llmMetadata: {
      ...existingMetadata,
      autoApproveDecision: decision,
      autoApproveReason: reason,
      autoCheckChecks: checkResult.checks.map((c) => ({ name: c.name, passed: c.passed, reason: c.reason })),
    },
  },
});
```

**Тест.** `findUnique` отдаёт пост с `{ hook, hookTechnique, qualityScore, visualConcept, simhash }`; после
`evaluate()` ожидать, что `update` получил `llmMetadata` с **обоими** наборами ключей (сейчас старые
отсутствуют).

### BUG-12. Полоса HUMAN_REVIEW недостижима при дефолтных порогах — **Medium** [CR-V]
`packages/backend/src/modules/autonomy/auto-approve.service.ts:91`

**Суть.** Корень — порядок гейтов в `evaluate()`. На `:68` сначала запускается `AutoCheck` с переданным
`qualityScore`; его `quality_score`-чек (`auto-check.service.ts:119-128`) падает при
`qualityScore < AUTO_CHECK_MIN_QUALITY_SCORE` (Joi-дефолт **6**, `env.validation.ts:83`), и тогда
`evaluate()` возвращает REJECT (`:71-74`) **до** матрицы решений. При дефолтах `humanReviewThreshold=4`,
но `autoCheckMin=6`, поэтому в полосу `[4,7)` для score 4–5 попасть нельзя — их всегда реджектит AutoCheck.
ADR-006 (`docs/adr/ADR-006-...:94`) явно предписывает `4-5 + passed → HUMAN_REVIEW`.

**Impact.** Пограничный контент (score 4–5) уходит в авто-REJECT и регенерацию вместо очереди ревью.
Хуже: AutoCheck на `:68` выполняется **до** короткого замыкания `!this.enabled` (`:77`), поэтому даже при
`AUTO_APPROVE_ENABLED=false` (дефолт) посты 4–5 переводятся в REJECTED вместо того, чтобы остаться DRAFT —
ломается обещание обратной совместимости. Плюс ложные срабатывания `checkRejectStreak` и лишние LLM-вызовы.

**Fix.** Не передавать `qualityScore` в `AutoCheck` — пусть матрица решений будет единственным источником
маршрутизации по score. Чек обёрнут в `if (qualityScore !== undefined)`, так что без аргумента он просто
пропускается, а контент-валидность (bait/char-limit/forbidden-phrase/dedup) остаётся.

```ts
// auto-approve.service.ts:68
- const checkResult = await this.autoCheck.check(content, network, qualityScore);
+ const checkResult = await this.autoCheck.check(content, network);  // score-маршрутизация — в матрице ниже (ADR-006)
```

> ⚠️ **Не** «чинить» понижением `AUTO_CHECK_MIN_QUALITY_SCORE` до 4 — это вернёт скрытую связку
> `autoCheckMin == humanReviewThreshold`, которая снова сломается при изменении любого из порогов.

**Тест.** При всех контент-чеках passed и `AUTO_APPROVE_ENABLED=true`: score 4 и 5 → HUMAN_REVIEW/DRAFT
(сейчас REJECT); score 3 → REJECT; score 6 → HUMAN_REVIEW. Disabled-кейс (score 4) → HUMAN_REVIEW/DRAFT.

---

## Engagement (вовлечение)

### BUG-2. Вовлечение встаёт навсегда после стартового дня — **High** [CR-V]
`packages/backend/src/modules/engagement/engagement-scheduler.service.ts:59`

**Суть.** `scheduleDailySessions()` вызывается ровно один раз — из `onModuleInit` (`:59`), а её тело
(`:77-119`) строит отложенные BullMQ-джобы только на сегодня (`const today = new Date()`, `:78`; окна с
`delay <= 0` пропускаются, `:88`). Нет ни `@Cron`, ни repeatable-джобы; воркер браузинг-сессии
(`modules/queue/queue.module.ts:78`) выполняет сессию и **не** ставит следующую. После отработки окон
стартового дня множество отложенных джоб пустеет, и ничто его не пополняет.

```ts
onModuleInit(): void {
  if (!this.enabled) { ...; return; }
  if (this.networks.length === 0) { ...; return; }
  this.scheduleDailySessions();          // единственный вызов, только на стартовый день
  this.logger.log(`Engagement scheduler started: ...`);
}
```

**Impact.** При `ENGAGEMENT_SCHEDULER_ENABLED=true` браузинг-сессии идут только в ещё-будущих окнах дня
старта, затем молча прекращаются навсегда (очереди просто пусты). Прогрев аккаунта/имитация активности
оживает только рестартом процесса (и снова лишь на один день).

**Fix.** Сделать ежедневное планирование рекуррентным `@Cron`-методом (в полночь), повторно применяя
guard'ы enabled/networks (сейчас они в `onModuleInit`, не в `scheduleDailySessions`). `ScheduleModule.forRoot()`
уже подключён (`app.module.ts:67`); BullMQ дедупит по `jobId`, так что повторный прогон безопасен.

```ts
import { Cron } from '@nestjs/schedule';

/** Ежедневно в полночь переустанавливает браузинг-сессии, чтобы вовлечение не умирало после дня старта. */
@Cron(process.env.ENGAGEMENT_SCHEDULE_CRON ?? '0 0 * * *')
scheduleDailySessionsCron(): void {
  if (!this.enabled || this.networks.length === 0) return;
  this.logger.log('Daily cron: re-scheduling browsing sessions for today');
  this.scheduleDailySessions();
}
```

**Тест.** Fake-timers: забутстрапить модуль, слить джобы стартового дня, перевести часы за полночь →
ожидать новый батч engagement-джоб. (Тест, проверяющий только `onModuleInit`, регрессию **не** ловит —
one-shot путь в день один работает.)

### BUG-3. Лимит вовлечения по факту 1 лайк + 1 коммент в день на сеть — **High** [CR-V]
`packages/backend/src/modules/engagement/human-behavior-engine.ts:267`

**Суть.** `RateLimitService` строит карты лимитов (`dailyLimits`/`weeklyLimits`/`minIntervalMs`) только для
ключей пост-сетей `['X','THREADS','FACEBOOK']` (конструктор `rate-limit.service.ts:46-65`). А движок
вовлечения зовёт `checkRateLimit`/`recordPost` с составными ключами `X-like`, `X-comment`
(`human-behavior-engine.ts:267/349`). Лукап `this.dailyLimits[network] ?? 1` (`:102`) не находит `X-like`
и молча падает на пост-дефолт **1/день**. Каждый ключ — отдельный Redis-счётчик: первый лайк проходит,
`recordPost('X-like')` поднимает счётчик до 1, второй лайк видит `1 >= 1` и реджектится.

```ts
const rateKey = `${context.network as string}-like`;          // "X-like" — не замаплен
const rateCheck = await this.rateLimitService.checkRateLimit(rateKey);
if (!rateCheck.allowed) { return { ...; success: false, error: `Rate limited: ${rateCheck.reason}` }; }
// ...
if (result.success) { await this.rateLimitService.recordPost(rateKey); ... }   // счётчик "X-like" = 1
```

**Impact.** Вовлечение жёстко ограничено 1 лайком и 1 комментом на сеть в день. Дальнейшие действия в сессии
блокируются (`Daily limit reached for X-like (1/1)`) и пишутся как FAILED-интеракции — `likesMaxPerSession`/
`commentsMaxPerSession` недостижимы, таблица `Interaction` засоряется, летят `interaction_failed` SSE.

**Fix.** Научить `RateLimitService` ключам действий вовлечения: для каждой сети дополнительно заполнить
лимиты для суффиксов `like`/`comment`/`reply` со своими (высокими) дефолтами и коротким min-interval. Оба
call-site (`human-behavior-engine.ts`, `engagement.service.ts:110`) чинятся без правок вызывающих.

```ts
// rate-limit.service.ts — конструктор
const engagementMinDelay = this.configService.get<number>('RATE_LIMIT_ENGAGEMENT_MIN_DELAY_MS', 3_000);
const engagementActions = [
  { suffix: 'like', dayDefault: 50, weekDefault: 250 },
  { suffix: 'comment', dayDefault: 10, weekDefault: 50 },
  { suffix: 'reply', dayDefault: 10, weekDefault: 50 },
] as const;

for (const net of networks) {
  this.dailyLimits[net]  = this.configService.get(`RATE_LIMIT_${net}_MAX_PER_DAY`, 1);
  this.weeklyLimits[net] = this.configService.get(`RATE_LIMIT_${net}_MAX_PER_WEEK`, 5);
  this.minIntervalMs[net] = globalMinDelay;

  for (const { suffix, dayDefault, weekDefault } of engagementActions) {
    const key = `${net}-${suffix}`;                        // "X-like" — совпадает с rateKey движка
    this.dailyLimits[key]  = this.configService.get(`RATE_LIMIT_${net}_${suffix.toUpperCase()}_MAX_PER_DAY`, dayDefault);
    this.weeklyLimits[key] = this.configService.get(`RATE_LIMIT_${net}_${suffix.toUpperCase()}_MAX_PER_WEEK`, weekDefault);
    this.minIntervalMs[key] = engagementMinDelay;
  }
}
```

**Тест.** В цикле `checkRateLimit('X-like')` + `recordPost('X-like')` остаётся allowed минимум до дневного
дефолта (50); `getStatus('X-like').dailyLimit > 1`. Интеграционно: 3 лайка в сессии → 3 COMPLETED (сейчас
1 COMPLETED + 2 FAILED).

### BUG-10. Невалидное окно (`NaN`) рушит весь тик планирования — **Medium** [CR-V]
`packages/backend/src/modules/engagement/engagement-scheduler.service.ts:141`

**Суть.** `applyJitter` берёт `hours/minutes` из `baseTime.split(':').map(Number)`. `??` ловит только
`null`/`undefined`, но **не** `NaN`, поэтому для нечислового сегмента (напр. `ENGAGEMENT_SESSION_WINDOWS=
'09:00,foo,18:00'` — `parseWindows` HH:MM не валидирует) `setHours(NaN, …)` даёт Invalid Date. Далее
`delayMs = NaN`; guard `delayMs <= 0` (`:88`) обходится (`NaN <= 0` === `false`), и `scheduledTime.toISOString()`
(`:94`) бросает `RangeError`. Вызов синхронный из `onModuleInit` без try/catch — раскрутка убивает
планирование для всех оставшихся сетей и окон.

```ts
private applyJitter(baseTime: string, date: Date): Date {
  const [hours, minutes] = baseTime.split(':').map(Number);
  const base = new Date(date);
  base.setHours(hours ?? 9, minutes ?? 0, 0, 0);     // ?? не ловит NaN → Invalid Date
  ...
}
```

**Impact.** Один кривой сегмент в `ENGAGEMENT_SESSION_WINDOWS` обрушивает весь дневной тик → ноль (или
частично) сессий, причём throw в `onModuleInit` выглядит как шумный сбой старта, а не понятная ошибка конфига.

**Fix.** Заменить NaN-слепой `?? default` на `Number.isFinite`, плюс defense-in-depth в `scheduleDailySessions`.

```ts
const safeHours   = Number.isFinite(hours)   ? hours   : 9;
const safeMinutes = Number.isFinite(minutes) ? minutes : 0;
base.setHours(safeHours, safeMinutes, 0, 0);

// scheduleDailySessions (~:88)
- if (delayMs <= 0) {
+ if (!Number.isFinite(delayMs) || delayMs <= 0) {
```

**Тест.** `ENGAGEMENT_SESSION_WINDOWS='09:00,foo,23:59'` + `onModuleInit()` → не бросает и ставит джобы для
валидных окон (сейчас `RangeError: Invalid time value`).

---

## Posting / Posters

### BUG-4. Верификация постинга даёт ложный POSTED — **High** [CR-V]
`packages/backend/src/modules/posting/posters/base.poster.ts:183`

**Суть.** `validatePostOnProfile` — гард подтверждения публикации в ветке тихого сбоя (для X срабатывает,
когда паттерн status-URL не совпал И ссылка на твит не найдена на странице: `x.poster.ts:240/399`). Текущий
дифф ослабил матч содержимого с «первые 100 символов в `textContent('body')`» до трёхступенчатой
неякорной лестницы: (1) `innerText` body содержит quote-stripped первые 40 символов; (2) fallback на
quote-stripped первые **30**; (3) скан `allInnerTexts()` **всех** постов профиля с матчем по **любому**.
Все три — «встречается ли короткий префикс где-то на профиле». 30-символьный префикс шаблонной/повторяющейся
вводной строки коллизит с уже имеющимся текстом.

```ts
const contentSnippet = content.slice(0, 40).trim().replace(/^["']+|["']+$/g, '');
const pageText = await page.innerText('body').catch(() => '');
if (!pageText || !pageText.includes(contentSnippet)) {
  const noQuoteSnippet = content.replace(/^["']+|["']+$/g, '').slice(0, 30).trim();  // <-- 30 символов
  if (pageText && pageText.includes(noQuoteSnippet)) { /* ok */ }
  else {
    const postTexts = await page.locator(postContentSelector).allInnerTexts().catch(() => []);
    const foundInPost = postTexts.find((t) => t.includes(noQuoteSnippet) || t.includes(contentSnippet));
    if (foundInPost) { /* ok — матч по ЛЮБОМУ посту */ }
    else throw new ValidationError(this.network, 'Posted content not found on profile page', { ... });
  }
}
```

**Impact.** Пост, который молча не опубликовался (rate limit, шэдоубан, временный сбой compose), помечается
успешным и **не ретраится** (`ValidationError` — `retryable=false`, `domain/errors.ts:132`; это единственный
гард ветки). Контент тихо теряется. Вторичный эффект — последующий URL-loop (`:211-219`) может вернуть URL
старого/закреплённого поста.

**Fix.** Поднять дискриминацию, **не** откатывая легитимные фиксы того же дифа (`innerText` вместо
`textContent` с CSS; `domcontentloaded`; quote-stripping): один длинный отпечаток (~80 символов или весь
пост, если короче), нормализация пробелов, без 30-символьной ступени. Полноценный фикс — **дифференциальный**:
снять снапшот существующих URL/постов профиля **до** публикации и требовать появления **нового** совпадения
(иммунно и к ложным POSTED, и к ложным FAILED на закреплённых постах).

```ts
const normalize = (s: string) => s.replace(/^["']+|["']+$/g, '').replace(/\s+/g, ' ').trim();
const expected = normalize(content);
const snippet = expected.slice(0, Math.min(expected.length, 80));     // 80, не 30

const pageText = normalize(await page.innerText('body').catch(() => ''));
let matched = snippet.length > 0 && pageText.includes(snippet);
if (!matched) {
  const postTexts = (await page.locator(postContentSelector).allInnerTexts().catch(() => [])).map(normalize);
  matched = postTexts.some((t) => t.includes(snippet));               // только длинный отпечаток
}
if (!matched) throw new ValidationError(this.network, 'Posted content not found on profile page', { expectedPattern: snippet, actualUrl: page.url() });
// РОБАСТНО (отдельно, на стороне вызывающего): снапшот URL постов ДО публикации + требовать НОВЫЙ матч.
```

**Related.** `base.poster.ts:211-219` (возврат первого `a[href]` по `postUrlPattern` — часто
закреплённый/верхний пост → неверный permalink); `x.poster.ts:240`, `x.poster.ts:399`,
`threads.poster.ts:172` (вызывающие; та же ослабленная валидация).

**Тест.** Спеков постеров нет. Ложно-позитивный кейс (ловит регрессию): на профиле только старый пост, чьи
первые ~30-40 символов совпадают с новым, дальше расходятся → `validatePostOnProfile` должна **бросить**
(сейчас возвращает URL).

### BUG-6. Тред через home-page fallback теряет все ответы — **High** [CR-V]
`packages/backend/src/modules/posting/posters/x.poster.ts:167`

**Суть.** `post()` принимает `content` и опциональный `threadItems`. Цикл публикации ответов треда — ниже
(`:261-285`) и выполняется только после основного compose-пути. Когда кнопка Post не видна, метод уходит в
home-page fallback: `postViaHomePageCompose(page, content)` (`:165`), который (а) объявлен только с
`content` (`:309`) — `threadItems` ему не передаются, и (б) при успехе делает `return fallbackResult`
(`:167`) — **до** цикла ответов. Envelope успеха (`{ url }`, без `error`) трактуется как полный успех.

```ts
if (!buttonVisible) {
  this.logger.warn(`X post button still not visible — falling back to home page compose dialog...`);
  const fallbackResult = await this.postViaHomePageCompose(page, content);   // только content
  if (fallbackResult) {
    return fallbackResult;                                                   // выход до цикла ответов
  }
}
```

**Impact.** Для любого многотвитного треда, где кнопка Post не видна (именно деградированная сессия, ради
которой fallback и добавляли), публикуется только корневой твит. Все `threadItems` молча теряются, ошибки
нет — UI сообщает полный успех. Тихая потеря контента.

**Fix.** Не делать ранний `return`, если есть незапощенные ответы. Вынести цикл ответов в
`postThreadReplies(page, postUrl, threadItems)` и вызывать из обоих путей.

```ts
if (fallbackResult) {
  if (fallbackResult.url && threadItems && threadItems.length > 0) {
    const replyResults = await this.postThreadReplies(page, fallbackResult.url, threadItems);
    return { ...fallbackResult, threadReplyResults: replyResults };
  }
  return fallbackResult;
}
// ...основной путь:
let replyResults = [];
if (threadItems && threadItems.length > 0 && postUrl) {
  replyResults = await this.postThreadReplies(page, postUrl, threadItems);
}
return { url: postUrl, threadReplyResults: replyResults };

// helper — извлечён из существующего цикла :260-284 (retryWithBackoff + postReply + randomDelay + учёт ошибок)
private async postThreadReplies(page: Page, postUrl: string, threadItems: string[]): Promise<Array<{ index: number; success: boolean; error?: string }>> { ... }
```

**Тест.** Мок: основная кнопка `isVisible()` всегда `false` (форсит fallback), fallback резолвит валидный
URL, `threadItems.length === 2` → `postReply` вызван дважды, `threadReplyResults.length === 2` (сейчас не
вызывается, `undefined`).

---

## Sessions / Auth

### BUG-5. Threads-куки на `.threads.net`, проверка на `threads.com` — **High** [CR-V]
`packages/backend/src/modules/sessions/sessions.service.ts:312`

**Суть.** `parseCookieString` (`:311-313`) ставит Threads-кукам домен `.threads.net`, но **вся** навигация
Threads идёт на `www.threads.com`: verification checkUrl в `tryCookieAuth` (`→ :245`), `healthCheck` (`:1129`),
login url (`:55`), весь `threads.poster.ts`. `threads.net` и `threads.com` — разные registrable-домены,
поэтому кука `.threads.net` на запрос к `threads.com` **не отправляется**: страница грузится
неаутентифицированной, `threads.com` редиректит на `/login`, и guard `currentUrl.includes('/login')`
(`:256-259`) возвращает `null`. Тот же устаревший домен — в `AUTH_COOKIES` (`:1084`, `domain:'threads.net'`),
который через `c.domain.includes(req.domain)` (`:265`, `:1151`) связан с `:312` — править надо **синхронно**.

```ts
const domain = network === 'X' ? '.x.com' :
  network === 'THREADS' ? '.threads.net' :    // <-- навигация идёт на threads.com
  '.facebook.com';
```

**Impact.** Cookie-auth Threads (предпочтительный, более стабильный путь, который `getOrCreateSession` пробует
**первым**) на 100% не работает — всегда `null`. Создание сессии форсится на хрупкий username/password
autoLogin (2FA, риск IP-бана, login circuit breaker) и падает совсем, если задан только `SOCIAL_THREADS_COOKIES`
без пароля. Даже при гипотетически сохранённой сессии `healthCheck` пометил бы её EXPIRED → вечный цикл
ре-аутентификации.

**Fix.** Согласовать домен куки с реальным хостом `threads.com`. Две связанные правки в одном изменении:

```ts
// parseCookieString (:312)
- network === 'THREADS' ? '.threads.net' :
+ network === 'THREADS' ? '.threads.com' :

// AUTH_COOKIES (:1083-1085) — менять В ПАРЕ, иначе c.domain.includes(req.domain) перестанет матчить
  THREADS: [
-   { name: 'sessionid', domain: 'threads.net' },
+   { name: 'sessionid', domain: 'threads.com' },
  ],
```

**Тест.** Для `'THREADS'` все куки `parseCookieString` имеют домен `.threads.com` (сейчас `.threads.net`).
Guard-тест консистентности: `AUTH_COOKIES.THREADS[0].domain` — подстрока домена из `parseCookieString` (чтобы
не разъехались). Интеграционно: `tryCookieAuth` с `page.url() === 'https://www.threads.com/'` создаёт сессию.

---

## Infrastructure (Redis / Queue / LLM / Health)

### BUG-8. `/health` зависает при недоступном Redis — **High** [CR-V]
`packages/backend/src/modules/health/health.controller.ts:35`

**Суть.** `HealthController` переведён со своего fail-fast клиента
(`new IORedis(url, { maxRetriesPerRequest: 1, lazyConnect: true })`) на инжектируемый общий `SHARED_REDIS`
(`:12`). Общий клиент (`redis.module.ts:46-50`) собран с `maxRetriesPerRequest: null` и бесконечным
`retryStrategy`. В ioredis это + дефолтный `enableOfflineQueue: true` означает: команда при упавшем сокете
ставится в offline-очередь и **никогда не реджектится**. Поэтому `await this.redis.ping()` (`:35`) не
сеттлится, `catch` (`:36`) недостижим, `check()` не возвращается.

```ts
// Check Redis (Sprint L: uses shared connection)
let redisStatus = 'connected';
try {
  await this.redis.ping();          // зависает на offline-очереди, не реджектится
} catch {
  redisStatus = 'disconnected';     // недостижимо при упавшем Redis
}
```

**Impact.** `GET /health` зависает при недоступном Redis вместо `{ status: 'degraded', redis: 'disconnected' }`.
k8s liveness/readiness таймаутится, помечает под нездоровым и рестартит/выводит из ротации — частичная
деградация эскалирует в полный простой/crash-loop.

**Fix.** Ограничить probe: (1) синхронный short-circuit, если `this.redis.status !== 'ready'`; (2) гонка
`ping()` против короткого таймаута (1000ms). Конфиг общего клиента **не** трогать (на нём держатся durable-
реконнекты других сервисов) — fail-fast нужен только health-probe.

```ts
let redisStatus = 'connected';
try {
  if (this.redis.status !== 'ready') throw new Error(`redis not ready: ${this.redis.status}`);
  await Promise.race([
    this.redis.ping(),
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error('redis ping timeout')), 1000)),
  ]);
} catch {
  redisStatus = 'disconnected';
}
```

**Тест.** Мок `SHARED_REDIS` с `ping = () => new Promise(() => {})` (никогда не сеттлится) и `status:'ready'` →
`check()` резолвится в ограниченное время и отдаёт `redis:'disconnected'` (сейчас зависает). Существующий
UTC-117 мокает ping через `mockRejectedValue` — реальный offline-hang он **не** воспроизводит, поэтому
регрессия и проскочила.

### BUG-9. Resume не восстанавливает `pendingWrites` → повтор нод — **Medium** [CR-V]
`packages/backend/src/infrastructure/checkpoint/redis-checkpoint.ts:84`

**Суть.** `putWrites()` (`:167-182`) сохраняет промежуточные записи под отдельным ключом
`spa:checkpoint:writes:{thread}:{checkpoint}` (`rpush`). Но read-пути `getTuple()` (`:96`, `:102`) и `list()`
(`:125`) только `JSON.parse` чекпойнт из основного/pointer-ключа и возвращают его как есть — ключ записей не
читается, поэтому `CheckpointTuple.pendingWrites` всегда `undefined`. При resume pregel-цикла его
`skipDoneTasks` опирается на `pendingWrites`, чтобы понять, какие задачи суперстепа уже завершились; с пустым
`pendingWrites` он считает, что не завершилась ни одна, и переисполняет все ноды.

```ts
async getTuple(config: RunnableConfig): Promise<CheckpointTuple | undefined> {
  ...
  if (checkpointId) {
    const data = await this.redis.get(this.getThreadKey(threadId, checkpointId));
    if (!data) return undefined;
    return JSON.parse(data) as CheckpointTuple;          // pendingWrites не выставлен
  }
  const latestData = await this.redis.get(this.getThreadKey(threadId));
  if (latestData) return JSON.parse(latestData) as CheckpointTuple;   // pendingWrites не выставлен
  return undefined;
}
```

**Impact.** После краша/HITL-паузы и resume завершённые ноды прерванного суперстепа выполняются заново:
дублирующая генерация и, хуже, **повторный постинг** уже опубликованного контента, плюс лишний расход
токенов. Сохранённые записи в Redis — фактически write-only мёртвые данные.

**Fix.** Хелпер читает список записей обратно и разворачивает в `CheckpointPendingWrite[]`
(`[taskId, channel, value]`); прикрепить к каждому возвращаемому tuple (обе ветки `getTuple()` и `list()`).

```ts
import { /* ... */ type PendingWrite, type CheckpointPendingWrite } from '@langchain/langgraph-checkpoint';

private async loadPendingWrites(threadId: string, checkpointId: string): Promise<CheckpointPendingWrite[]> {
  const entries = await this.redis.lrange(this.getWritesKey(threadId, checkpointId), 0, -1);
  const pending: CheckpointPendingWrite[] = [];
  for (const entry of entries) {
    const { taskId, writes } = JSON.parse(entry) as { taskId: string; writes: PendingWrite[] };
    for (const [channel, value] of writes) pending.push([taskId, channel, value]);
  }
  return pending;
}
// в getTuple()/list(): return { ...tuple, pendingWrites: await this.loadPendingWrites(threadId, tuple.checkpoint.id) };
```

**Тест.** `putWrites(config, [['channel_a','v1']], 'task-1')`, затем `getTuple(...)` → `pendingWrites`
deep-equal `[['task-1','channel_a','v1']]`. Мок Redis сейчас **не имеет** `lrange` — сам этот пробел
показывает, что read-back путь никогда не исполнялся.

### BUG-11. `BULLMQ_MAX_RETRIES=0` молча превращается в 3 — **Medium** [CR-V]
`packages/backend/src/infrastructure/queue/queue.factory.ts:41`

**Суть.** Паттерн `Number(get(KEY, default)) || fallback`: логический OR срабатывает на любом falsy-левом
операнде, а распарсенный `0` — falsy. Значит `BULLMQ_MAX_RETRIES=0` → `0 || 3 = 3`; аналогично
`BULLMQ_RETRY_DELAY_MS=0 → 60000` (`:42`). `maxRetries` идёт как BullMQ `attempts`. Против установленного
bullmq 5.79.1 (`shouldRetryJob`: `attemptsMade + 1 < attempts`) `attempts:0` = ровно один прогон без
ретраев — именно то, что хочет оператор.

```ts
this.maxRetries  = Number(this.configService.get<string>('BULLMQ_MAX_RETRIES', '3')) || 3;       // 0 → 3
this.retryDelayMs = Number(this.configService.get<string>('BULLMQ_RETRY_DELAY_MS', '60000')) || 60000;  // 0 → 60000
this.concurrency = Number(this.configService.get<string>('BULLMQ_CONCURRENCY_PER_QUEUE')) || 1;
```

**Impact.** Оператор ставит `BULLMQ_MAX_RETRIES=0`, чтобы отключить ретраи (избежать дублей при пост-сабмит
ошибке подтверждения), но получает `attempts=3`. На частично успешной публикации (пост улетел, воркер упал
после) BullMQ перезапускает джобу до 2 раз → **дубли постов**. `RETRY_DELAY_MS=0` (ретрай немедленно) тоже
молча превращается в 60s.

**Fix.** Парсер, который падает на fallback только при действительно отсутствующем/нечисловом значении,
сохраняя валидный `0`. Для concurrency `0` невалиден → явный `Math.max(1, …)`.

```ts
this.maxRetries  = this.parseIntEnv('BULLMQ_MAX_RETRIES', 3);          // 0 теперь честный
this.retryDelayMs = this.parseIntEnv('BULLMQ_RETRY_DELAY_MS', 60000);
this.concurrency = Math.max(1, this.parseIntEnv('BULLMQ_CONCURRENCY_PER_QUEUE', 1));

private parseIntEnv(key: string, fallback: number): number {
  const raw = this.configService.get<string>(key);
  if (raw === undefined || raw === null || raw === '') return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}
```

**Related.** `queue.factory.ts:42` (RETRY_DELAY_MS=0 — тот же баг), `:44` (CONCURRENCY=0 → 1, тут 0 невалиден —
лучше явный clamp), `analytics.controller.ts:30` (`parseInt(limit,10) || 10` — `?limit=0` отдаёт 10; тот же
корень, read-only, безвреден).

**Тест.** `ConfigService.get('BULLMQ_MAX_RETRIES') → '0'` ⇒ `factory.maxRetries === 0` и `queue.add` с
`attempts: 0`. Кейс unset → дефолты 3/60000.

### BUG-13. `GenerateOptions.maxTokens` молча игнорируется адаптером — **Medium** [CR-V]
`packages/backend/src/infrastructure/llm/llm.service.ts:245`

**Суть.** `LlmService` — единственный `ILlmPort`-адаптер — задаёт параметры генерации в двух местах:
`ctorArgs` в `getModelForProvider` (`:245-251`) и per-call override в `invokeWithFallback` (`:404-409`).
`temperature` прокидывается в обоих, `maxTokens` — **ни в одном** (`model.maxTokens` нигде не присваивается),
и в `LlmProviderConfig` поля `maxTokens` нет. `GenerateOptions.maxTokens` (`llm.port.ts:10`) принимается по
типу, но структурно отбрасывается до `ChatOpenAI.invoke()`. При этом ChatOpenAI это поддерживает
(`maxTokens?: number`, settable, как `temperature`).

```ts
private getModelForProvider(provider: LlmProviderConfig): ChatOpenAI {
  ...
  const ctorArgs: Record<string, unknown> = { model, apiKey, configuration, timeout: 30000, maxRetries: 0 };
  if (provider.supportsTemperature) ctorArgs.temperature = provider.temperature;   // maxTokens не задаётся
  ...
}
// invokeWithFallback :404-409
if (options?.temperature !== undefined && provider.supportsTemperature) {
  model.temperature = options.temperature;            // model.maxTokens — никогда
}
```

**Impact.** `EngagementDecisionService.generateComment` (`:140-144`) зовёт
`generateChat(sys, user, { temperature: 0.7, maxTokens: 100 })`, чтобы держать ответы короткими, но кап в 100
токенов отбрасывается. Единственный пост-гард `isForbiddenComment` длину не проверяет, так что многословный
коммент постится как ответ → превышение лимита символов (X — 280), сбои/обрезка. Аналогично уплывают
`maxTokens` в `:49`/`:102` (JSON-решения) → больший расход токенов.

**Fix.** Прокинуть `maxTokens` в per-call override (правильное место — приходит per-call, а не из конфига).
Инстансы ChatOpenAI кэшируются и переиспользуются — присваивать **безусловно** (включая сброс в `undefined`),
чтобы кап одного вызова не утёк на следующий безлимитный.

```ts
if (options?.temperature !== undefined && provider.supportsTemperature) {
  model.temperature = options.temperature;
}
// Прокидываем maxTokens; инстанс кэшируется per-provider → всегда присваиваем (в т.ч. undefined),
// чтобы кап прошлого вызова (maxTokens:100) не утёк на безлимитный.
model.maxTokens = options?.maxTokens;
```

> Опционально для reasoning-моделей (`supportsTemperature === false`) слишком низкий кап может уйти в
> reasoning-токены и дать пустой ответ — поднять пол (`Math.max(maxTokens, 512)`) или мапить на
> `maxCompletionTokens`. Для engagement-пути неактуально (reasoning-модели в конце fallback-цепочки).

**Тест.** Стаб `ChatOpenAI.invoke`, шпион на инстанс из `getModelForProvider`: (1) `generateChat(...,{maxTokens:100})`
→ `model.maxTokens === 100` на момент invoke; (2) затем `generateChat(...)` без `maxTokens` на том же
кэшированном провайдере → `model.maxTokens === undefined` (нет утечки). Сейчас (1) падает.

---

## Ниже порога отчёта (низкий приоритет)

Обзор подтвердил 47 находок, в топ-15 (выше) попали по severity-капу. Остальные — низкоприоритетные
DRY/perf/dead-code очистки. Не верифицированы отдельным дообогащением, перечислены как кандидаты:

- `stores/analytics.ts:93` — `GET /analytics/autonomous` дёргается из UI, но такого роута в `AnalyticsController`
  нет (вероятный 404 на autonomous-статистике). **Стоит проверить** — потенциально не косметика.
- `analytics.service.ts:97` — `getDailyStats` группирует по UTC-дате, но окно запроса и метки дней — по
  server-local времени; на не-UTC хосте календари расходятся (ср. `rate-limit.service` намеренно переведён на UTC).
- `content-enhancements/trend-guardrail.ts:85` — `path.startsWith('trending/') || path.includes('trending/')`
  избыточно (`includes` уже покрывает); неиспользуемый параметр `sourceType`.
- `trending-scraper.service.ts:538` — почти идентичные merge-циклы Google/X-трендов → вынести `mergeSource(...)`.
- `thread-depth.controller.ts:119` — двойной `Math.min(MAX_THREAD_DEPTH, Math.min(factsCount+1, 5))` (MAX=5).
- `thread-depth.controller.ts:123` — `else { targetDepth = this.defaultDepth }` — no-op (значение уже такое).
- `hook-performance-bank.ts:399` — строка no-data guidance дублирует `:347` → вынести в константу.
- `browser.factory.ts:189` — FB persistent-context vs pooled разбросан тремя `if (network === 'FACEBOOK')`
  по create/acquire/release → стратегия получения контекста.

---

## Рекомендуемый порядок исправления

1. **Безопасность (SEC-1, SEC-2)** — обход единственного guard опасных эндпоинтов; малый дифф, высокий риск.
2. **Тихие убийцы фич:** BUG-1 (автономия реджектит всё), BUG-3 (вовлечение 1/день), BUG-5 (Threads cookie-auth),
   BUG-2 (вовлечение встаёт), BUG-6 (потеря ответов треда), BUG-4 (ложный POSTED).
3. **Данные/надёжность:** BUG-7 (затирание метаданных), BUG-8 (health-hang), BUG-9 (дубли на resume).
4. **Конфиг/хрупкость:** BUG-10, BUG-11, BUG-12, BUG-13.

Каждый пункт сопровождается заметкой по регрессионному тесту (выше) — рекомендуется TDD: тест красный →
фикс → зелёный.
