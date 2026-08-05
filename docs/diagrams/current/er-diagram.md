# Prisma ER Diagram — Current State

> **Data model:** 15 Prisma models, their fields, and relationships.
> **As-is:** PostgreSQL on port 5433. SocialNetwork enum (X/THREADS/FACEBOOK), PostStatus lifecycle, PostThread for thread chains.

```mermaid
erDiagram
    AccountGroup ||--o{ SocialAccount : "group"
    SocialAccount ||--o{ Session : "account"
    SocialAccount ||--o{ Post : "account"
    SocialAccount ||--o{ PostThread : "account"
    SocialAccount ||--o{ Interaction : "account"
    SocialAccount ||--o{ BrowsingSession : "account"
    GenerationRun ||--o{ Post : "generationRun"
    PostThread ||--o{ Post : "thread"
    Post ||--o{ PostVariant : "variants"
    Post ||--o{ PostMetrics : "metrics"
    Post ||--o{ IncomingComment : "incomingComments"
    IncomingComment ||--o{ IncomingComment : "children"
    BrowsingSession ||--o{ Interaction : "interactions"

    AccountGroup {
        String   id              PK
        String   name
        String   proxyUrl
        String   timezone
        Json     fingerprintProfile
        DateTime createdAt
        DateTime updatedAt
    }

    SocialAccount {
        String         id              PK
        SocialNetwork  network
        String         handle
        String         displayName
        Int            priority
        String         groupId         FK
        String         fingerprintSeed
        String         proxyUrl
        String         credentialsRef  "env var names, not secrets"
        Boolean        active
        Boolean        warmupEnabled
        DateTime       warmupStartedAt
        Int            warmupDaysTotal
        DateTime       createdAt
        DateTime       updatedAt
    }

    Session {
        String        id              PK
        String        accountId       FK
        Json          storageState    "typed Json, holds ciphertext"
        SessionStatus status
        DateTime      lastHealthCheck
        DateTime      createdAt
        DateTime      updatedAt
    }

    GenerationRun {
        String               id            PK
        GenerationTrigger    triggeredBy
        Json                 sourceTopics
        GenerationRunStatus  status
        DateTime             startedAt
        DateTime             completedAt
        String               errorMessage
    }

    Topic {
        String   id         PK
        String   topic      "unique"
        Json     keywords
        Json     facts
        String   category
        String   sourceType "llm|trending|manual"
        String   status     "active|used|archived"
        DateTime usedAt
        DateTime createdAt
        DateTime updatedAt
    }

    ContentSource {
        String   id         PK
        String   sourceType "cap_file|db|rss|api|google_trends"
        String   name
        Boolean  enabled
        Int      priority
        Json     config
        DateTime lastRunAt
        String   lastError
        DateTime createdAt
        DateTime updatedAt
    }

    PostThread {
        String     id         PK
        String     accountId  FK
        PostStatus status
        DateTime   createdAt
        DateTime   postedAt
    }

    ThreadProgress {
        String   id           PK
        String   postId       "FK root post"
        String   replyPostId  "FK reply post"
        Int      position
        String   status       "PENDING|POSTED|FAILED"
        String   postUrl
        DateTime attemptedAt
        DateTime completedAt
        String   error
    }

    Post {
        String         id              PK
        String         generationRunId FK
        String         accountId       FK
        String         threadId        FK
        Int            threadPosition  "0=root, 1+=reply"
        SocialNetwork  network
        String         language
        String         content         "final post text"
        Json           sourceRef
        String         sourcePath
        PostStatus     status
        String         postUrl
        String         errorMessage
        Int            retryCount
        Json           llmMetadata     "model, tokens, cost, judgeScores"
        String         simhash
        DateTime       createdAt
        DateTime       approvedAt
        DateTime       postedAt
    }

    PostVariant {
        String        id          PK
        String        postId      FK
        SocialNetwork network
        String        label       "a|b|base|default|custom"
        String        content
        Json          judgeScores
        Boolean       selected
        DateTime      postedAt
        DateTime      metricsAt
        Int           likes
        Int           comments
        Int           shares
        Int           impressions
        DateTime      createdAt
    }

    PostMetrics {
        String        id          PK
        String        postId      FK
        SocialNetwork network
        Int           likes
        Int           comments
        Int           shares
        Int           impressions
        DateTime      collectedAt
    }

    Interaction {
        String             id                 PK
        String             accountId          FK
        InteractionType    type
        InteractionStatus  status
        String             targetUrl
        String             targetHandle
        String             content
        String             errorMessage
        String             screenshotPath
        String             browsingSessionId  FK
        DateTime           createdAt
        DateTime           completedAt
    }

    IncomingComment {
        String        id                PK
        String        postId            FK
        SocialNetwork network
        String        commentId         "platform-specific"
        String        author
        String        text
        String        authorProfileUrl
        String        commentUrl
        String        parentId          FK "self-ref"
        String        conversationId
        Int           depth
        Boolean       isQuestion
        Float         questionConfidence
        String        questionType
        String        replyUrl
        CommentStatus status
        String        replyText
        DateTime      replyPostedAt
        Boolean       needsHumanReview
        String        humanReviewReason
        DateTime      scrapedAt
        DateTime      createdAt
    }

    BrowsingSession {
        String               id                PK
        String               accountId         FK
        BrowsingSessionStatus status
        DateTime             startedAt
        DateTime             endedAt
        Int                  durationSec
        Int                  postsViewed
        Int                  interactionsCount
        String               feedUrl
        String               errorMessage
    }

    Admin {
        String   id           PK
        String   username     "unique"
        String   passwordHash "scrypt: saltHex:hashHex"
        DateTime createdAt
        DateTime updatedAt
    }
```

## Key details

### 15 models
- **AccountGroup** — proxy/fingerprint grouping for accounts.
- **SocialAccount** — one per (network, handle), unique. `credentialsRef` stores **env var names** (comma-separated), never the password itself.
- **Session** — Playwright `storageState` per account. `storageState` is typed `Json` with a stale "cookies, localStorage" comment but actually holds **ciphertext** (AES-256-GCM, `v1:` prefix) when `SESSION_ENCRYPTION_KEY` is set.
- **GenerationRun** — one per generation batch (cron/manual/autonomous). `sourceTopics` is a JSON array.
- **Topic** — LLM-generated topics (replaces CAP repo dependency for topic sourcing). `status: active|used|archived`.
- **ContentSource** — configurable input adapters for `IContentPort` (`cap_file`, `db`, `rss`, `api`, `google_trends`).
- **PostThread** — groups a root post + its replies for thread chains. `status` mirrors `PostStatus`.
- **ThreadProgress** — per-reply tracking for resumable threads (P0-H2). `@@unique([postId, replyPostId])` for dedup.
- **Post** — the central entity. `threadPosition=0` is root, `1+` are replies. `simhash` for fast near-duplicate dedup. `llmMetadata` holds model/tokens/cost/judgeScores.
- **PostVariant** — A/B testing variants with real-world outcome metrics.
- **PostMetrics** — F6 engagement metrics scraping (likes, comments, shares, impressions).
- **Interaction** — engagement actions (LIKE, COMMENT, FOLLOW, REPLY, etc.). Links to `BrowsingSession`.
- **IncomingComment** — Sprint Q / F4: comments on our posts, tracked for automated reply monitoring. Self-referential `parentId` for nested replies; `conversationId` groups a thread.
- **BrowsingSession** — engagement scroll sessions (feed browsing for like/comment).
- **Admin** — single admin account for UI JWT auth. Bootstrapped from `ADMIN_USERNAME`/`ADMIN_PASSWORD` env vars. Password hashed with `crypto.scrypt` (`saltHex:hashHex`).

### Enums
- **`SocialNetwork`** — `X`, `THREADS`, `FACEBOOK` (the 3 platforms today; no syndication yet).
- **`PostStatus`** — `DRAFT` → `APPROVED` → `POSTING` → `POSTED` (or `FAILED` / `REJECTED`).
- **`SessionStatus`** — `ACTIVE`, `EXPIRED`, `ERROR`, `WARMUP` (F20 new-account ramp), `BANNED` (F21 health monitor).
- **`GenerationRunStatus`** — `RUNNING`, `COMPLETED`, `FAILED`, `PAUSED`.
- **`GenerationTrigger`** — `CRON`, `MANUAL`, `AUTONOMOUS`.
- **`InteractionType`** — `LIKE`, `COMMENT`, `FOLLOW`, `UNFOLLOW`, `REPLY`, `REPOST`, `QUOTE`, `SCROLL_VIEW`.
- **`InteractionStatus`** — `PENDING`, `IN_PROGRESS`, `COMPLETED`, `FAILED`, `SKIPPED`.
- **`BrowsingSessionStatus`** — `ACTIVE`, `COMPLETED`, `FAILED`, `ABORTED`.
- **`CommentStatus`** — `NEW`, `REPLIED`, `SKIPPED`, `HUMAN_REVIEW`, `REPLIED_MANUAL`.

### Key relationships
- `SocialAccount ||--o{ Post` — one account, many posts.
- `SocialAccount ||--o{ Session` — one account, many sessions (login storageState).
- `GenerationRun ||--o{ Post` — one run produces 3 posts (X, THREADS, FACEBOOK) per topic.
- `Post ||--o{ PostVariant` — A/B variants per post.
- `Post ||--o{ PostMetrics` — time-series metrics snapshots.
- `Post ||--o{ IncomingComment` — tracked comments for reply monitoring.
- `PostThread ||--o{ Post` — thread chain (root + replies).
- `IncomingComment ||--o{ IncomingComment` — self-referential nested replies (`parentId`).

### Non-obvious
- **`credentialsRef` stores env var name, not secret** — the actual password/token lives in env vars, read at runtime. `RedactInterceptor` strips `credentialsRef` from logs.
- **`storageState` typed `Json` but holds ciphertext** — when `SESSION_ENCRYPTION_KEY` is set, values carry a `v1:` prefix and are AES-256-GCM encrypted. Absent/malformed key = plaintext passthrough in dev but **hard boot failure in production**.
- **`PostThread` for thread chains** — a root post (`threadPosition=0`) plus reply posts (`threadPosition=1+`) share a `threadId`. `ThreadProgress` tracks per-reply posting status for crash-resume.
- **`Topic` replaces CAP repo dependency** for topic sourcing — `TopicGenerationService` cron generates topics, `DbContentReader` consumes them. CAP repo on disk is still a content source via `ContentSource` (`sourceType: cap_file`).
