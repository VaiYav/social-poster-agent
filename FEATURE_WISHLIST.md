---
project: Social Poster Agent (SPA)
document: Feature Wishlist
version: 0.4.0
last_updated: 2026-06-26
owner: Valentyn Yakovlev
status: draft / brainstorm
---

# Feature Wishlist — Social Poster Agent

> **Назначение документа.** Фиксация "хотелок" фичей до их формализации в
> конституции и spec-ах. Каждый пункт — это идея с описанием, мотивацией, и
> открытыми вопросами. После брейншторма и разрешения вопросов фичи мигрируют
> в CONSTITUTION.md (scope/roadmap) и получают отдельные spec-ы.

---

## F1. Autonomous User-Agent (эмуляция живого юзера)

### Описание
LLM-управляемый браузерный агент, который имитирует поведение реального
пользователя соц-сети: лайкает посты, пишет комментарии, вступает в
дискуссии, репостит. Цель — создать реалистичный паттерн активности вокруг
аккаунта, чтобы он выглядел как живой пользователь, а не как бот-постер.

### Мотивация
- Аккаунт-только-постер выглядит подозрительно для алгоритмов соц-сетей
- Реальная активность повышает trust score аккаунта → выше reach постов
- Комментарии под чужими постами = бесплатный organic exposure
- Дискуссии в нише астрологии = community building

### Концепция
```
┌─────────────────────────────────────────────────────┐
│  Autonomous User-Agent (LangGraph + Camoufox)       │
│                                                      │
│  ┌──────────┐   ┌───────────┐   ┌───────────────┐  │
│  │ Browse   │──▶│ LLM Decide│──▶│ Execute Action│  │
│  │ feed/    │   │ (like?    │   │ (click like /  │  │
│  │ search/  │   │  comment? │   │  type comment /│  │
│  │ profile) │   │  scroll?) │   │  reply)        │  │
│  └──────────┘   └───────────┘   └───────┬───────┘  │
│       ▲                                 │           │
│       └─────────────────────────────────┘           │
│                 (loop: human-like delays)            │
└─────────────────────────────────────────────────────┘
```

### Ключевые аспекты
- **LLM решает** какое действие совершить на основе контекста (пост, тема,
  релевантность бренду)
- **Реалистичные жесты**: scroll, hover, pause, потом click — не мгновенно
- **Контент комментариев**: LLM генерирует осмысленные комментарии в рамках
  brand voice, без спама, без кликбейта
- **Таргетинг**: engagement с постами по хэштегам (#astrology, #horoscope,
  #zodiac) или по подпискам конкурентов
- **Лимиты**: гораздо строже чем постинг (лайки/комментарии детектятся
  быстрее)

### Resolved decisions (brainstorm 2026-06-26)
- **Лайки**: 10-20/день/сеть (реалистично, ниже radar)
- **Комментарии**: 3-5/день/сеть (каждый через LLM, качество + безопасность)
- **Дискуссии**: 1-2/день (длинные reply chains только если релевантно)
- **Browsing**: 2-3 сессии/день по 5-15мин (читаем feed для реалистичности)
- **Таргетинг**: ВСЕ источники — хэштеги (#astrology #horoscope #zodiac),
  посты конкурентов (Co-Star, The Pattern, Sanctuary), под своими постами,
  algorithmic feed (For You / Explore)
- **Reply на комментарии под нашими постами**: это F4 (Adaptive Replies),
  не F1. F1 = engagement с чужим контентом.
- **LLM для decision-making**: Ollama gemma4 (local, бесплатно) для F1
  (like/scroll/comment decisions). Cloud (gpt-4o-mini) для генерации
  текста комментариев.

---

## F2. Multi-Stage Posting (хук → контент → ссылка)

### Описание
Постинг в несколько этапов: первый пост = хук (интригующий вопрос/тезис),
второй пост = продолжение со ссылкой на сайт/контент. Применимо для X.com
и Threads (треды). Для Facebook — TBD (не известно как работает там).

### Мотивация
- Хук в первом посте привлекает внимание в feed
- Ссылка во втором посте = выше CTR (алгоритмы режут reach постов с ссылками)
- Треды = больше engagement (люди читают продолжение)
- Естественный storytelling pattern

### Концепция
```
Этап 1 (T+0):  "Did you know Mars in Aries changes how you react to conflict?"
               ↓ (hook, no link, pure engagement bait)

Этап 2 (T+30min): "Here's how Mars transits affect YOUR chart:
                  myzodiacai.com/mars-in-aries"
                  ↓ (content + link, rides on engagement of stage 1)

Опционально:
Этап 3 (T+2h):   Reply с дополнительным фактом/инсайтом (keep thread alive)
```

### Ключевые аспекты
- **Timing между этапами**: configurable (30мин, 2ч, 6ч — не сразу)
- **Генерация**: LangGraph генерит все этапы сразу, но постит по расписанию
- **X.com**: тред (reply to own tweet) — естественный формат
- **Threads**: тред (reply to own thread) — естественный формат
- **Facebook**: TBD — возможно просто пост + комментарий с ссылкой?

### Resolved decisions (brainstorm 2026-06-26)
- **Timing**: фиксированный 30мин между этапами (просто, предсказуемо)
- **Этапов максимум**: 2-3 (хук → ссылка → опциональный bonus факт)
- **Facebook**: TBD — пост + комментарий с ссылкой (prototype в Phase 1)
- **Если этап 1 не получил engagement**: всё равно постим этап 2 (MVP),
  condition-based отмена в phase 2

---

## F3. On-Demand Feature Launch + Model Selection

### Описание
UI-управляемый запуск фичей по клику. Например, кликаю "Start F1" →
открываются 3 параллельных браузера (по одному на сеть) → начинается
autonomous agent activity. При запуске выбираю LLM модель: из
content-agent-platform (cloud) или локальную (Ollama).

### Мотивация
- Гибкость: запускать только то что нужно сейчас
- Экономия: локальная модель для простых задач (scroll, like), cloud для
  сложных (генерация комментариев)
- Контроль: вижу что происходит в реальном времени
- Параллельность: 3 сети одновременно = в 3 раза быстрее

### Концепция
```
UI: Feature Control Panel
┌─────────────────────────────────────────────────┐
│  Active Features:                                │
│                                                   │
│  [F1: Autonomous Agent]  [▶ Start]  [⏸ Pause]   │
│    Model: [Ollama/gemma4 ▼]   Networks: [X][T][F]│
│    Status: idle                                   │
│                                                   │
│  [F2: Multi-Stage Post]  [▶ Start]  [⏸ Pause]   │
│    Model: [gpt-4o-mini ▼]   Topic: [select ▼]    │
│    Status: idle                                   │
│                                                   │
│  [F4: Adaptive Replies]  [▶ Start]  [⏸ Pause]   │
│    Model: [gpt-4o-mini ▼]   Networks: [X][T]     │
│    Status: idle                                   │
└─────────────────────────────────────────────────┘
```

### Ключевые аспекты
- **Model picker**: dropdown с доступными моделями (cloud + local)
- **Network selector**: чекбоксы X / Threads / Facebook
- **Parallel browsers**: 1 browser per network, запускаются одновременно
- **Real-time status**: что делает агент прямо сейчас (browsing, commenting,
  posting) — visible в UI
- **Stop/Pause/Resume**: в любой момент без потери состояния

### Resolved decisions (brainstorm 2026-06-26, updated v0.3.0)
- **Локальная модель**: Ollama gemma4 (как в content-agent-platform, GPU available)
- **Model picker**: dropdown в UI — cloud (gpt-4o-mini, claude) + local (Ollama gemma4)
- **3 параллельных браузера**: 3 browser instances (3GB RAM, полная изоляция per network)
- **Real-time status**: SSE (Server-Sent Events) для live updates (вместо tRPC subscription)
- **Model choice в LangGraph**: передаётся как параметр в workflow, LlmService
  создаёт model instance по выбору

---

## F4. Adaptive Reply Handling (ответы на комментарии юзеров)

**Status: MVP done** — backend, UI, tests, ADR-008 and runbook in place. Notification-page scraping and factual-grounded question answers remain future enhancements.

### Описание
Если юзер оставил комментарий или ответил на наш пост — агент адаптивно
проверяет что он написал и отвечает в рамках правильности контента.
Если это prompt injection / токсичный комментарий / спам — игнорирует.

### Мотивация
- Engagement с аудиторией = community building
- Быстрый ответ = выше satisfaction
- Автоматизация рутины (отвечать на "cool!" или "thanks!" вручную — скучно)
- Безопасность: injection detection защищает аккаунт

### Концепция
```
1. Poll/scan comments on recent posts (notification-page scanning is a future enhancement)
2. Для каждого нового комментария/reply:
   a. Прочитать контекст (оригинальный пост + ветка комментариев)
   b. LLM classify: genuine / injection / spam / toxic / question
   c. Если genuine question/comment → LLM generate reply (brand voice, factual)
   d. Если injection/spam/toxic → ignore (не отвечать, не взаимодействовать)
   e. Если question → ответить с фактом из content-agent-platform factbase
3. Записать в БД (Reply entity: original comment, our reply, classification)
```

### Ключевые аспекты
- **Injection detection**: LLM classify — пытается ли юзер заставить агента
  сделать что-то вне brand voice? (ignore system prompt, request admin actions,
  extract secrets)
- **Factual grounding**: ответы на вопросы должны базироваться на контенте
  сайта/content-agent-platform, не выдумываться
- **Rate limit на replies**: не отвечать на каждый комментарий (подозрительно),
  лимит N replies/день
- **Tone matching**: ответить в tone оригинального комментария (casual → casual,
  serious → serious)
- **Escalation**: если комментарий требует человеческого ответа (complex question,
  complaint) → alert оператору, не отвечать автоматически

### Resolved decisions (brainstorm 2026-06-26, updated v0.3.0)
- **Polling**: Poll раз в 15-30мин (вместо WebSocket — слишком хрупко через
  browser automation). Agent открывает browser, проверяет notifications,
  отвечает, закрывает. Реалистичнее для живого юзера.
- **Injection detection**: LLM classify + LLM fact-check (2-step):
  1. LLM classify: genuine / injection / spam / toxic / question
  2. Если genuine+question → LLM fact-check: ответ базируется на
     content-agent-platform factbase, не выдумывается
- **Лимит replies**: 5-10/день/сеть (не отвечать на всё — подозрительно)
- **Negative comments (жалобы)**: escalate оператору, не отвечать автоматически
- **Reply language**: English MVP, multi-language в phase 2
- **Genuine vs rhetorical**: LLM classify определяет (если rhetorical —
  не отвечаем, просто лайкаем)

---

## F5. Pauseable/Resumable Agent Environment

### Описание
Agent environment можно запустить, остановить, продолжить или начать с нуля
в любой момент. UI отображает очереди (Redis/BullMQ) и состояние БД,
позволяет управлять контентом.

### Мотивация
- Гибкость: не нужно 24/7, запускаю когда удобно
- Безопасность: могу остановить если что-то идёт не так
- Transparency: вижу что в очередях, что в БД, могу управлять
- Recovery: после краша или рестарта — продолжить с того же места

### Концепция
```
UI: Environment Control
┌─────────────────────────────────────────────────────┐
│  Agent Environment                                   │
│  Status: [● Running / ○ Paused / ○ Stopped]         │
│  [▶ Start All]  [⏸ Pause All]  [⏹ Stop All]        │
│  [↻ Restart Clean]                                   │
│                                                      │
│  ┌─ Redis Queues ──────────────────────────────┐    │
│  │ posting:     [██████████] 8 jobs             │    │
│  │ generation:  [██░░░░░░░░] 2 jobs             │    │
│  │ engagement:  [██████░░░░] 5 jobs             │    │
│  │ replies:     [░░░░░░░░░░] 0 jobs             │    │
│  │ dead-letter: [██░░░░░░░░] 2 jobs ⚠️          │    │
│  └──────────────────────────────────────────────┘    │
│                                                      │
│  ┌─ DB State ──────────────────────────────────┐    │
│  │ Posts:     142 total (12 drafts, 120 posted) │    │
│  │ Sessions:  3 active, 0 expired               │    │
│  │ Replies:   28 total (24 sent, 4 escalated)   │    │
│  │ Engagements: 89 total (62 likes, 27 comments) │    │
│  └──────────────────────────────────────────────┘    │
│                                                      │
│  [View Queue Details]  [Manage Posts]  [Clear DLQ]  │
└─────────────────────────────────────────────────────┘
```

### Ключевые аспекты
- **State persistence**: browser sessions (storageState), BullMQ jobs,
  LLM context — всё переживает restart
- **Pause vs Stop**: pause = завершить текущие действия, не начинать новые;
  stop = немедленно остановить (browser close, worker stop)
- **Restart clean**: очистить очереди, сбросить сессии, начать с нуля
- **Queue visualization**: real-time отображение BullMQ queues (waiting,
  active, completed, failed, dead-letter)
- **Content management**: редактировать/удалять посты из UI, retry failed
  jobs, clear dead-letter queue
- **Graceful shutdown**: SIGTERM → завершить текущие browser actions →
  save sessions → close browsers → stop workers

### Resolved decisions (brainstorm 2026-06-26)
- **LangGraph state**: Redis checkpoint (быстро, volatile — при restart
  продолжаем с последнего checkpoint)
- **In-progress browser action при pause**: завершить текущее действие
  (graceful), не начинать новые. При stop — abort немедленно + save session.
- **Restart clean**: выборочно — очистить очереди (Redis), сбросить сессии
  (опционально), посты в БД оставить (история)
- **Queue visualization**: BullMQ events → SSE (real-time updates в UI, не polling)

---

## F6. Analytics Dashboard

### Описание
Dashboard с метриками engagement: лайки/ретвиты/охват наших постов, тренды,
best performing content, сравнение сетей.

### Мотивация
- Понять что работает, а что нет
- Data-driven решения по контент-стратегии
- ROI visible (сколько engagement на сколько effort)

### Концепция
```
UI: Analytics
┌─────────────────────────────────────────────────────┐
│  Overview (last 30 days)                             │
│  ┌──────┐ ┌──────┐ ┌──────┐ ┌──────┐               │
│  │ 142  │ │ 1.2K │ │ 89   │ │ 234  │               │
│  │posts │ │likes │ │replies│ │clicks│               │
│  └──────┘ └──────┘ └──────┘ └──────┘               │
│                                                      │
│  Engagement by Network                               │
│  X:       ████████████ 4.2 avg likes/post           │
│  Threads: ████████ 2.8 avg likes/post               │
│  FB:      ████ 1.5 avg likes/post                   │
│                                                      │
│  Top Performing Posts                                │
│  1. "Mars in Aries changes..." (X) — 42 likes       │
│  2. "Your moon sign reveals..." (Threads) — 28 likes │
│  3. ...                                              │
└─────────────────────────────────────────────────────┘
```

### Ключевые аспекты
- **Data source**: scraping metrics с наших постов через browser (лайки,
  ретвиты visible на странице поста)
- **Frequency**: раз в день cron собирает metrics для постов за последние
  30 дней
- **Storage**: PostMetrics table (postId, likes, retweets, replies, timestamp)
- **No official API**: всё через browser scraping (как и постинг)

### Фаза: Phase 2

---

## F7. Content Calendar

### Описание
Планирование постов на неделю/месяц вперёд. Визуальный календарь в UI,
drag-and-drop scheduling, preview контента.

### Мотивация
- Стратегическое планирование вместо реактивного
- Видеть gaps (дни без постов)
- Coordinate с другими маркетинг-активностями

### Концепция
```
UI: Calendar
┌─────────────────────────────────────────────────────┐
│  June 2026                          [< Prev] [Next>] │
│  Mo Tu We Th Fr Sa Su                                │
│  ────────────────────────────────                    │
│  26 27 28 29 30 31  1                                │
│   X  T  F          X  T                              │
│  ────────────────────────────────                    │
│   2  3  4  5  6  7  8                                │
│      X  T  F          X  T  F                        │
│  ...                                                 │
│                                                      │
│  [▶ Generate for empty slots]  [📅 Schedule post]    │
└─────────────────────────────────────────────────────┘
```

### Фаза: Phase 2

---

## F8. A/B Testing постов

### Описание
2 варианта поста на одну тему — постим оба (в разное время или в разные
сети), смотрим какой engagement выше.

### Мотивация
- Data-driven оптимизация контента
- Понять какой tone/hook работает лучше
- Постепенное улучшение brand voice на основе данных

### Концепция
- LangGraph генерит 2 варианта (разные hooks, разные angles)
- Постим вариант A в X, вариант B в Threads (или в разное время в X)
- F6 Analytics сравнивает engagement
- Результаты feed back в brand-voice.md (learning loop)

### Фаза: Phase 2-3

---

## F9. Cross-Posting Sync

### Описание
> **Resolved**: F9 = sequential per-network angle (уже в конституции v0.3.0
> §10.3). Не отдельная фича, а часть основного workflow.

Cross-posting — это базовый behaviour SPA: один topic → 3 поста (per-network
angle) → постятся sequentially. Не simultaneous, не без адаптации.

### Фаза: Уже в MVP (конституция §10.3)

---

## F10. Content Repurposing Engine (article → multi-post extraction)

### Описание
Вместо topic-based генерации — deep extraction из опубликованных статей.
Одна статья → 5-10 постов (разные факты/инсайты/хуки). Умножает content ROI:
одна статья = неделя контента для всех 3 сетей.

### Мотивация
- На сайте уже сотни SEO-статей — неисчерпаемый источник фактов
- Topic-based генерация = 1 пост per topic. Article extraction = 5-10 постов
  per article — в 5-10x больше контента из того же источника
- Факты из статей уже fact-checked (ClaimAuditor в CAP) — выше качество
- Разные факты из одной статьи = разнообразие контента

### Концепция
```
Article: "Mars in Aries: What It Means for Your Zodiac Sign"
  │
  ├─ Fact 1: "Mars in Aries happens every 2 years" → X post (punchy)
  ├─ Fact 2: "Aries Mars = impulsive action, conflict-ready" → Threads (narrative)
  ├─ Fact 3: "Mars in Aries affects fire signs most" → FB (conversational question)
  ├─ Fact 4: "Mars stays in Aries ~6 weeks" → X post (quick fact)
  ├─ Fact 5: "Mars in Aries = good time to start projects" → Threads (storytelling)
  └─ ...
```

### Ключевые аспекты
- **LangGraph workflow**: article → extract_facts (LLM: 5-10 ключевых фактов)
  → per fact: hook + angle_per_network → draft → critique → refine
- **Дедупликация**: не постим факт который уже постили (SimHash на тексте)
- **Source tracking**: source_ref = { type: 'article', path, fact_index }
- **Совместимость**: работает параллельно с topic-based генерацией (cron
  чередует: один запуск = topics, другой = article extraction)

### Resolved decisions (brainstorm 2026-06-26)
- **Режим генерации**: cron чередует topic-based и article-extraction запуски
  (например: 9:00 = topics, 21:00 = article repurposing)
- **Источники**: content/blog/en/*.md (опубликованные статьи с frontmatter)
- **Лимит фактов**: 5-10 per article (configurable)
- **Фаза**: Phase 1.5 (MVP+) — низкий риск, high ROI, не требует нового browser
  behavior

### Фаза: Phase 1.5 (MVP+)

---

## F11. Best Time to Post (data-driven scheduling)

### Описание
Анализировать когда наша аудитория наиболее активна на каждой сети и
рекомендовать слоты для постинга. Data-driven, на основе F6 Analytics.

### Мотивация
- Пост в "правильное" время = 2-3x больше engagement
- Астрология-аудитория активна вечерами (18-22) и выходными — но data точнее
- Автоматизация: оператор не думает "когда постить"

### Ключевые аспекты
- **Зависит от F6**: нужны engagement metrics per post per time slot
- **Алгоритм**: aggregate engagement by hour-of-day + day-of-week per network
- **Recommendation**: "Best slot for X: Tue 19:00, Thu 21:00, Sat 14:00"
- **Integration с F7 Calendar**: auto-fill calendar slots по best times

### Фаза: Phase 2 (после F6 Analytics)

---

## F13. Content Recycling / Evergreen Revival

### Описание
Заметить старый пост который хорошо зашёл → создать refreshed версию (новый
angle, тот же факт, актуальная дата). Астрология = evergreen контент:
"Mars in Aries" актуален каждый ~2 года.

### Мотивация
- Лучшие посты заслуживают второй жизни
- Новый angle = новый аудитория (не все видели первый пост)
- Астрологические события цикличны — контент не устаревает
- Low effort: LangGraph уже умеет генерить per-angle

### Концепция
```
1. F6 Analytics: "Mars in Aries" post got 42 likes (top 5%)
2. 90 дней спустя → F13 triggers: "Recycle candidate: Mars in Aries"
3. LangGraph: old post + new date/context → new angle → fresh draft
4. Operator approves → post
```

### Ключевые аспекты
- **Trigger**: post age > 90 дней + engagement > top 25% (configurable)
- **Дедупликация**: SimHash (уже в §10.2) — не копия, а новый angle
- **Context update**: если факт изменился (новые эфемериды) — обновить
- **Frequency limit**: не рециклить тот же пост чаще 1x/год

### Фаза: Phase 1.5 (MVP+) — low risk, high ROI

---

## F19. Image Quote Cards

### Описание
Авто-генерация text-on-image карточек для постов. Текст поста на красивом
фоне с zodiac-эстетикой. Posts с images получают 2-3x больше engagement.

### Мотивация
- Астрология = визуальный контент (Co-Star, The Pattern — визуальные бренды)
- Posts с images получают 2-3x больше engagement в всех соц-сетях
- Quote cards = shareable = organic reach
- Автоматизация: не нужен дизайнер

### Концепция
```
Post text: "Mars in Aries changes how you react to conflict"
  │
  ▼
Satori/SVG → PNG pipeline:
┌─────────────────────────┐
│  ✦  ✦  ✦                │
│                          │
│  "Mars in Aries changes  │
│   how you react to       │
│   conflict"              │
│                          │
│  — My Zodiac AI          │
│  myzodiacai.com          │
│  ✦  ✦  ✦                │
└─────────────────────────┘
```

### Ключевые аспекты
- **Pipeline**: text → SVG template (zodiac-themed background) → PNG (Satori
  или sharp)
- **Templates**: 3-5 templates (dark/cosmic, light/minimal, gradient)
- **Per-network**: X = 16:9, Threads = 4:5, FB = 1:1
- **Browser upload**: Camoufox загружает image + текст (сложнее чем text-only)
- **Brand consistency**: templates соответствуют Cosmic Glass design system

### Фаза: Phase 2 (после MVP) — browser image upload сложнее text-only

---

## F20. Session Warm-up Mode

### Описание
Новый аккаунт который сразу начинает постить = red flag для алгоритмов.
Warm-up: первые несколько дней только browsing (без постов), потом
постепенный старт. Снижает риск бана для новых аккаунтов.

### Мотивация
- Новый аккаунт + сразу постинг = bot pattern
- Warm-up имитирует живого юзера: сначала читает, потом начинает постить
- Снижает риск бана на старте
- Особенно важно если добавляем новые аккаунты/сети в будущем

### Концепция
```
Day 1-3:   Browse only (open feed, scroll, close). 0 posts.
Day 4-5:   Browse + 1 post (light content). 1 post/day.
Day 6-7:   Browse + 1-2 posts. Normal rate.
Day 8+:    Normal operation (1 post/day/network).
```

### Ключевые аспекты
- **UI toggle**: "Warm-up mode" per account (включается при создании нового)
- **Browsing**: agent открывает browser, скроллит feed 5-10 мин, закрывает
  (как F1 browsing, но без лайков/комментариев)
- **Gradual ramp**: post frequency увеличивается постепенно
- **Logging**: warm-up progress visible в UI (Day 3/7)
- **Для текущих аккаунтов**: не нужно (уже "состарились" — OQ-4)

### Фаза: Phase 0/1 (встроить в MVP как опцию)

---

## F21. Account Health Monitor

### Описание
Регулярная проверка здоровья всех систем: не забанен ли аккаунт, не протухла
ли сессия, не осталось ли stalled jobs, не переполнена ли dead-letter queue.
Alert в UI если что-то не так.

### Мотивация
- "Почему не постит?" → ответ через 1 секунду в UI, а не через дебаг логов
- Раннее обнаружение бана → быстрее реакция
- Stalled jobs накапливаются silently — нужен мониторинг
- Dead-letter queue переполнение = потерянные посты

### Ключевые аспекты
- **Cron**: раз в час проверяет:
  - Session status per account (active/expired/banned)
  - BullMQ queue health (stalled jobs, dead-letter count)
  - DB + Redis connectivity
  - Account not banned (try navigate to profile page)
- **UI**: Health dashboard (зелёный/жёлтый/красный per system)
- **SSE alert**: real-time push если статус меняется на "unhealthy"
- **Banned detection**: navigate to profile → if "account suspended" → alert

### Фаза: MVP (встроить в Phase 1)

---

## F22. Trending Topic Detection

### Описание
Поймать когда астрология-тема trending (Mercury retrograde, eclipse,
planetary event). Google Trends + X trending → приоритетная генерация поста
пока тема горячая.

### Мотивация
- Trending topic = 10-100x больше reach чем обычный пост
- Астрологические события предсказуемы (Mercury retrograde dates известны)
- Быстрый пост пока тема trending = free organic reach
- Конкуренты (Co-Star) тоже реагируют на trending — нужно быть быстрым

### Концепция
```
1. Cron (раз в день) → check Google Trends "astrology" + X trending topics
2. Если Mercury retrograde trending → приоритетная генерация
3. LangGraph: trending topic → fast-track generation (skip queue)
4. Operator gets push notification: "Trending: Mercury retrograde — post ready"
5. Approve → post immediately (skip normal queue)
```

### Ключевые аспекты
- **Sources**: Google Trends API (free) + X trending topics (browser scrape)
- **Astro events calendar**: известные даты (Mercury retrograde, eclipses,
  planetary ingresses) — можно хардкодить или брать из CAP astro MCP
- **Priority queue**: trending posts skip normal BullMQ queue
- **Push notification**: SSE + optional Telegram/email для оператора
- **Time window**: постить в течение 2-6 часов пока тема горячая

### Фаза: Phase 1.5 (MVP+)

---

## Связи между фичами

```
F1 (Autonomous Agent) ←→ F4 (Adaptive Replies)
    │                        │
    │  both use browser      │  both use LLM
    │  both need Camoufox    │  both need injection detection
    │                        │
    ▼                        ▼
F3 (On-Demand Launch) ←→ F5 (Pauseable Environment)
    │                        │
    │  F3 controls F1/F2/F4  │  F5 manages state of all
    │  model selection       │  queue/state visualization
    │                        │
    ▼                        ▼
F2 (Multi-Stage Post)
    │
    │  uses LangGraph generation
    │  uses BullMQ for staged timing

F10 (Repurposing) ←→ F13 (Recycling)
    │                    │
    │  both use LangGraph │  both need SimHash dedup
    │  both use content   │  F13 needs F6 for "best posts"
    │  source adapter     │
    │                    │
    ▼                    ▼
F22 (Trending) ────→ priority generation
    │
    │  trending topic → skip queue → fast-track LangGraph
    │
    ▼
F21 (Health Monitor) ──→ SSE alert → UI
    │
    │  monitors: sessions, queues, bans, DLQ
    │
    ▼
F20 (Warm-up) ──→ F21 monitors warm-up progress
    │
    │  new account → browse-only → gradual ramp
    │
    ▼
F11 (Best Time) ←── F6 (Analytics)
    │                  │
    │  needs engagement │  needs posted_at + metrics
    │  data per slot    │
    │                  │
    ▼                  ▼
F7 (Calendar) ←── F11 recommends slots
    │
    │  visual planning + auto-fill best times
    │
    ▼
F19 (Quote Cards) ←─ F8 (A/B Testing)
    │                   │
    │  image + text      │  test image vs text-only
    │  per network       │
```

---

## Приоритизация (обновлённая)

| Фича | Сложность | Риск бана | Ценность | Фаза |
|------|-----------|-----------|----------|------|
| F9 (Cross-Posting Sync) | — | — | — | Уже в MVP (§10.3) |
| F21 (Health Monitor) | Низкая | Нет | Высокая | **MVP (Phase 1)** |
| F20 (Warm-up Mode) | Низкая | Снижает | Средняя | **Phase 0/1 (опция)** |
| F2 (Multi-Stage Post) | Низкая | Низкий | Высокая | Phase 1.5 (MVP+) |
| F5 (Pauseable Environment) | Средняя | Нет | Высокая | Phase 1.5 (MVP+) |
| F3 (On-Demand Launch) | Средняя | Нет | Высокая | Phase 1.5 (MVP+) |
| F10 (Content Repurposing) | Средняя | Нет | Высокая | Phase 1.5 (MVP+) |
| F13 (Content Recycling) | Средняя | Низкий | Высокая | Phase 1.5 (MVP+) ✅ Done |
| F22 (Trending Detection) | Средняя | Нет | Высокая | Phase 1.5 (MVP+) |
| F6 (Analytics Dashboard) | Средняя | Низкий | Высокая | Phase 2 ✅ Done |
| F7 (Content Calendar) | Средняя | Нет | Средняя | Phase 2 ✅ Done |
| F11 (Best Time to Post) | Низкая | Нет | Средняя | Phase 2 (после F6) ✅ Done |
| F19 (Image Quote Cards) | Средняя | Низкий | Высокая | Phase 2 ✅ Done |
| F4 (Adaptive Replies) | Высокая | Средний | Средняя | Phase 2 |
| F8 (A/B Testing) | Высокая | Низкий | Средняя | Phase 2-3 |
| F1 (Autonomous Agent) | Очень высокая | Высокий | Высокая | Phase 2-3 |

> **MVP**: F9 (built-in) + F21 (health) + F20 (warm-up опция)
> **Phase 1.5 (MVP+)**: F2, F3, F5, F10, F13, F22 — все low/medium risk, high value
> **Phase 2**: F6, F7, F11, F19, F4 — safe additions + replies
> **Phase 2-3**: F8, F1 — complex, high risk
>
> F10 + F13 = content ROI multiplier (5-10x больше контента из существующих статей)
> F22 = trending detection (10-100x reach когда тема горячая)
> F21 = "почему не постит?" → ответ в UI за 1 секунду

---

## Bottlenecks и подводные камни

### B1. RAM: 3 параллельных браузера (~3GB)

**Проблема:** 3 browser instances (OQ resolved: 3 browsers, не contexts) =
~3GB RAM. Плюс Node.js, Redis, Postgres = ~5GB total.

**Митигация:**
- 3 browsers только когда F1 (Autonomous Agent) активен
- Для простого постинга — 1 browser, multi-context (как в конституции)
- Configurable: env `MAX_PARALLEL_BROWSERS` (default: 1 для постинга, 3 для F1)
- Monitor RAM в UI, alert если >80%

### B2. Captcha при логине/browsing

**Проблема:** Соц-сети могут показать captcha при логине или подозрительной
активности (особенно F1 autonomous browsing).

**Митигация (resolved: Manual MVP, auto phase 2):**
- MVP: при captcha → screenshot + alert в UI, оператор решает вручную
- Persistent sessions = редкий логин = меньше captcha
- Phase 2: 2captcha / anti-captcha API интеграция (если captcha частые)

### B3. LLM cost для F1 (Autonomous Agent)

**Проблема:** F1 делает много LLM calls (decision per post in feed: like?
comment? scroll?). При 10-20 лайках + 3-5 комментариях/день = ~30-50 LLM
calls/день/сеть = 90-150 total.

**Митигация (resolved: Ollama gemma4 для F1):**
- Local Ollama gemma4 для decision-making (бесплатно)
- Cloud (gpt-4o-mini) только для генерации текста комментариев (3-5/день)
- Cost: ~$0.01-0.02/день только на cloud calls для комментариев

### B4. Ban risk: engagement vs posting

**Проблема:** Лайки/комментарии детектятся алгоритмами быстрее чем постинг.
Автономный agent ставящий лайки = выше риск бана чем agent только постящий.

**Митигация:**
- Консервативные лимиты (10-20 лайков, 3-5 комментариев/день)
- Человекоподобные задержки (5-30с между действиями)
- F1 = Phase 2-3, после того как постинг стабилен и аккаунт "состарился"
- Если бан → stop F1 immediately, постинг продолжается

### B5. F4 polling stability

**Проблема:** Polling раз в 15-30мин через browser automation — browser
открывается, проверяет notifications, закрывается. Может быть медленно
или хрупко.

**Митигация:**
- Poll 15-30мин — достаточно для social media replies (не realtime chat)
- Persistent sessions = browser открывается быстро (cookies уже есть)
- F4 = Phase 2, не блокирует MVP
- Fallback: если poll не работает → manual trigger из UI

### B6. LangGraph checkpoint в Redis (volatile)

**Проблема:** Redis checkpoint = при Redis crash теряем LangGraph state.
Workflow начинается заново.

**Митигация:**
- Redis persistence: AOF (append-only file) включить в docker-compose
- Для критичных workflows (generation) — дублировать state в Postgres
- Для non-critical (F1 browsing) — потеря state = просто начать новую
  сессию, не критично

### B7. Facebook UI хрупкость (уже R2 в конституции)

**Проблема:** Facebook часто меняет UI (A/B tests), селекторы ломаются.

**Митигация:**
- Page Object pattern (уже в конституции §17)
- Integration test на fixture HTML
- F1 на Facebook = Phase 3 (самый сложный UI,最高 ban risk)

### B8. Content-agent-platform factbase для F4

**Проблема:** F4 (Adaptive Replies) требует factbase для fact-check ответов.
Content-agent-platform имеет Qdrant factbase, но SPA — Node.js, не Python.

**Митигация:**
- SPA читает factbase через HTTP API (content-agent-platform FastAPI)
- Или: SPA имеет свой embeddings store (Qdrant) для фактов сайта
- MVP: простой keyword search по content/blog/en/*.md (без embeddings)
- Phase 2: proper embeddings через CAP API или свой Qdrant

### B9. Concurrency: BullMQ + browser actions

**Проблема:** BullMQ worker берёт job, открывает browser, делает action.
Если 2 jobs для одной сети одновременно — 2 browser contexts на один
аккаунт = подозрительно.

**Митигация:**
- BullMQ queue per network: `posting-x`, `posting-threads`, `posting-facebook`
- Concurrency=1 per queue (один action per network за раз)
- F1 (engagement) и posting — разные очереди, но тоже concurrency=1 per network

### B10. State consistency: Redis vs Postgres

**Проблема:** Post.status в Postgres, BullMQ job в Redis. Если Post.status=
APPROVED но job потерян в Redis → пост зависнет.

**Митигация:**
- Reconciliation cron: раз в час проверяет APPROVED посты без active job
- Если найден → re-enqueue в BullMQ
- Post.retry_count отслеживает количество попыток

---

## Влияние на инфраструктуру (новые требования от wishlist)

### Docker-compose дополнения
- **Redis AOF persistence** (B6 mitigation): `--appendonly yes` в redis config
- **Ollama** (F3 local model): опционально в docker-compose для F1/F3
  (port 11434, model gemma4)

### Новые env vars
```env
# F1 Autonomous Agent limits
F1_LIKES_MAX_PER_DAY=15
F1_COMMENTS_MAX_PER_DAY=4
F1_DISCUSSIONS_MAX_PER_DAY=1
F1_BROWSING_SESSIONS_PER_DAY=3
F1_BROWSING_SESSION_MINUTES=10

# F2 Multi-stage posting
F2_DELAY_BETWEEN_STAGES_MS=1800000   # 30 минут
F2_MAX_STAGES=3

# F3 Model selection
OLLAMA_URL=http://localhost:11434
OLLAMA_DEFAULT_MODEL=gemma4
MAX_PARALLEL_BROWSERS=1              # 3 когда F1 активен

# F4 Adaptive replies
F4_REPLIES_MAX_PER_DAY=7
F4_POLL_INTERVAL_MS=900000           # 15 мин poll interval (browser-based polling)

# BullMQ queues (B9)
BULLMQ_QUEUE_PREFIX=spa              # spa:posting-x, spa:posting-threads, ...
BULLMQ_CONCURRENCY_PER_QUEUE=1       # один action per network за раз
```

### Новые Prisma models (для F4, F6)
```
Reply (F4)
  id: UUID
  post_id: FK → Post
  original_comment: text       ← что написал юзер
  original_author: string      ← username юзера
  classification: enum { GENUINE, INJECTION, SPAM, TOXIC, QUESTION, RHETORICAL }
  our_reply: text              ← наш ответ (nullable если ignored/escalated)
  status: enum { PENDING, REPLIED, IGNORED, ESCALATED }
  replied_at: timestamp
  created_at: timestamp

PostMetrics (F6)
  id: UUID
  post_id: FK → Post
  likes: int
  retweets: int                ← X/Threads only
  replies: int
  collected_at: timestamp
```

### Новые REST endpoints (NestJS controllers)
- `engagement` (F1): POST /engagement/start, POST /engagement/stop, GET /engagement/status, GET /engagement/config
- `replies` (F4): GET /replies, POST /replies/:id/reply, POST /replies/:id/ignore, POST /replies/:id/escalate
- `environment` (F5): POST /environment/start-all, POST /environment/pause-all, POST /environment/stop-all, POST /environment/restart-clean, GET /environment/queues, GET /environment/db-status
- `analytics` (F6): GET /analytics/overview, GET /analytics/by-network, GET /analytics/top-posts
- `calendar` (F7): GET /calendar/:month, POST /calendar/schedule, POST /calendar/generate-for-slots

---

## Changelog

| Version | Date | Changes |
| 0.5.0 | 2026-08-06 | Marked F6, F7, F11, F13, F19 as implemented. Updated feature priority table status. |
|---------|------|---------|
| 0.1.0 | 2026-06-26 | Initial wishlist: 5 features (F1-F5), prioritization, connections map |
| 0.2.0 | 2026-06-26 | Brainstorm resolved: F1-F5 decisions, added F6-F9, 10 bottlenecks (B1-B10), infra impact (env vars, Prisma models, tRPC routers) |
| 0.3.0 | 2026-06-26 | Pragmatism review (v0.4.0 constitution): F4 WebSocket → Poll 15-30мин. F3 tRPC subscription → SSE. tRPC routers → REST endpoints. Ollama GPU confirmed. |
| 0.4.0 | 2026-06-26 | Added 7 new features: F10 (Content Repurposing), F11 (Best Time), F13 (Content Recycling), F19 (Image Quote Cards), F20 (Warm-up Mode), F21 (Health Monitor), F22 (Trending Detection). Updated connections map. F21 → MVP, F20 → Phase 0/1, F10/F13/F22 → Phase 1.5, F11/F19 → Phase 2. |
