# ER Diagram — Future State (Extended)

> **Prisma ER diagram:** Extended with syndication fields and new enum values.
> **To-be:** All existing models PLUS new fields for canonical URLs, syndication tracking, judge scores, and content types.

```mermaid
erDiagram
    AccountGroup ||--o{ SocialAccount : has
    SocialAccount ||--o{ Session : has
    SocialAccount ||--o{ Post : authors
    SocialAccount ||--o{ PostThread : owns
    SocialAccount ||--o{ Interaction : performs
    SocialAccount ||--o{ BrowsingSession : has
    GenerationRun ||--o{ Post : produces
    PostThread ||--o{ Post : contains
    Post ||--o{ PostVariant : has
    Post ||--o{ PostMetrics : has
    Post ||--o{ IncomingComment : receives

    AccountGroup {
        String id PK
        String name
        String proxyUrl
        String timezone
        Json fingerprintProfile
        DateTime createdAt
        DateTime updatedAt
    }

    SocialAccount {
        String id PK
        SocialNetwork network "Extended: X,THREADS,FACEBOOK,DEVTO,HASHNODE,LINKEDIN,BLUESKY,MASTODON,TELEGRAM,MEDIUM,SUBSTACK,REDDIT,QUORA,PINTEREST"
        String handle
        String displayName
        Int priority
        String groupId FK
        String fingerprintSeed
        String proxyUrl
        String credentialsRef "env var names (never the secret)"
        Boolean active
        Boolean warmupEnabled
        DateTime warmupStartedAt
        Int warmupDaysTotal
        DateTime createdAt
        DateTime updatedAt
    }

    Session {
        String id PK
        String accountId FK
        Json storageState "ciphertext (v1: prefix) or plaintext"
        SessionStatus status
        DateTime lastHealthCheck
        DateTime createdAt
        DateTime updatedAt
    }

    GenerationRun {
        String id PK
        GenerationTrigger triggeredBy
        Json sourceTopics
        GenerationRunStatus status
        DateTime startedAt
        DateTime completedAt
        String errorMessage
    }

    Post {
        String id PK
        String generationRunId FK
        String accountId FK
        String threadId FK
        Int threadPosition
        SocialNetwork network "Extended: 14 platforms"
        String language
        String content
        Json sourceRef
        String sourcePath
        PostStatus status "Extended: +JUDGED, +VERIFIED"
        String postUrl
        String errorMessage
        Int retryCount
        Json llmMetadata
        String simhash
        ContentType contentType "NEW: SOCIAL_POST, ARTICLE, ANSWER, PIN"
        String canonicalUrl "NEW: POSSE canonical blog URL"
        Json syndicatedUrls "NEW: { network: url } map"
        Json judgeScores "NEW: LLM-as-a-Judge scores"
        Boolean judgeRetried "NEW: judge triggered refine retry"
        DateTime createdAt
        DateTime approvedAt
        DateTime postedAt
    }

    PostVariant {
        String id PK
        String postId FK
        SocialNetwork network
        String label
        String content
        Json judgeScores
        Boolean selected
        DateTime postedAt
        DateTime metricsAt
        Int likes
        Int comments
        Int shares
        Int impressions
        DateTime createdAt
    }

    PostMetrics {
        String id PK
        String postId FK
        SocialNetwork network
        Int likes
        Int comments
        Int shares
        Int impressions
        DateTime collectedAt
    }

    PostThread {
        String id PK
        String accountId FK
        PostStatus status
        DateTime createdAt
        DateTime postedAt
    }

    ThreadProgress {
        String id PK
        String postId
        String replyPostId
        Int position
        String status
        String postUrl
        DateTime attemptedAt
        DateTime completedAt
        String error
    }

    Topic {
        String id PK
        String topic
        Json keywords
        Json facts
        String category
        String sourceType
        String status
        DateTime usedAt
        DateTime createdAt
        DateTime updatedAt
    }

    ContentSource {
        String id PK
        String sourceType
        String name
        Boolean enabled
        Int priority
        Json config
        DateTime lastRunAt
        String lastError
        DateTime createdAt
        DateTime updatedAt
    }

    Interaction {
        String id PK
        String accountId FK
        InteractionType type
        InteractionStatus status
        String targetUrl
        String targetHandle
        String content
        String errorMessage
        String screenshotPath
        String browsingSessionId FK
        DateTime createdAt
        DateTime completedAt
    }

    IncomingComment {
        String id PK
        String postId FK
        SocialNetwork network
        String commentId
        String author
        String text
        String authorProfileUrl
        String commentUrl
        String parentId FK
        String conversationId
        Int depth
        Boolean isQuestion
        Float questionConfidence
        String questionType
        String replyUrl
        CommentStatus status
        String replyText
        DateTime replyPostedAt
        Boolean needsHumanReview
        String humanReviewReason
        DateTime scrapedAt
        DateTime createdAt
    }

    BrowsingSession {
        String id PK
        String accountId FK
        BrowsingSessionStatus status
        DateTime startedAt
        DateTime endedAt
        Int durationSec
        Int postsViewed
        Int interactionsCount
        String feedUrl
        String errorMessage
    }

    Admin {
        String id PK
        String username
        String passwordHash
        DateTime createdAt
        DateTime updatedAt
    }
```

## Key details

### New enum values

**SocialNetwork** (was 3, now 14):
| Value | Phase | Method |
|-------|-------|--------|
| X, THREADS, FACEBOOK | Existing | Camoufox (pooled/persistent) |
| DEVTO, HASHNODE, LINKEDIN | Phase 1 | Camoufox persistent + LLM-in-the-loop |
| BLUESKY, MASTODON | Phase 2 | Camoufox persistent + LLM-in-the-loop |
| TELEGRAM | Phase 2 | Bot API (only API exception) |
| MEDIUM, SUBSTACK | Phase 3 | Camoufox persistent + LLM-in-the-loop |
| REDDIT, QUORA | Phase 4 | Camoufox persistent + LLM-in-the-loop (participation) |
| PINTEREST | Phase 4 | Camoufox persistent + LLM-in-the-loop |

**PostStatus** (was 6, now 8):
| Value | Meaning |
|-------|---------|
| DRAFT, APPROVED, POSTING, POSTED, FAILED, REJECTED | Existing |
| JUDGED | NEW — LLM-as-a-Judge evaluated, awaiting auto-approve decision |
| VERIFIED | NEW — Published AND verified on platform (POST_VERIFIED event emitted) |

**ContentType** (NEW enum):
| Value | Used for |
|-------|----------|
| SOCIAL_POST | Short social posts (X, Threads, Facebook, LinkedIn, Bluesky, Mastodon, Telegram) |
| ARTICLE | Long-form articles (Dev.to, Hashnode, Medium, Substack) |
| ANSWER | Participation answers (Reddit, Quora) |
| PIN | Pinterest pins |

### New Post fields
| Field | Type | Purpose |
|-------|------|---------|
| `contentType` | ContentType | Distinguishes social posts from articles from answers (default: SOCIAL_POST) |
| `canonicalUrl` | String? | POSSE canonical URL — blog URL that articles point back to |
| `syndicatedUrls` | Json? | `{ [network: string]: string }` — platform URLs after syndication |
| `judgeScores` | Json? | LLM-as-a-Judge scores `{ anti_ai_tone, hook_strength, factual_accuracy, ... }` |
| `judgeRetried` | Boolean | True if judge triggered a refine retry (max 3) |

### Per-platform auto-approve thresholds
- `AUTO_APPROVE_MIN_SCORE` (default 7) — global fallback
- `AUTO_APPROVE_MIN_SCORE_DEVTO=7`, `AUTO_APPROVE_MIN_SCORE_HASHNODE=7`, `AUTO_APPROVE_MIN_SCORE_LINKEDIN=7`
- `AUTO_APPROVE_MIN_SCORE_REDDIT=9` — strictest (Reddit bans for self-promo)
- Stored as env vars, looked up by `AutoApproveService` per platform

### Existing fields (unchanged)
- `credentialsRef` — stores env var *name* (e.g. `DEVTO_EMAIL,DEVTO_PASSWORD`), never the secret itself
- `storageState` — typed `Json` but holds ciphertext (v1: prefix) when `SESSION_ENCRYPTION_KEY` set
- `sourceRef` — JSON with `{ type, path, topic, ... }` for content provenance tracking
- `simhash` — precomputed SimHash for near-duplicate detection (Hamming ≤3 = skip)
