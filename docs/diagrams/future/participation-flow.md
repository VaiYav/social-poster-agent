# Participation Flow — Reddit/Quora/Pinterest

> **Sequence diagram:** Agent participation mode — finding questions, drafting answers, judging, posting.
> **To-be:** Different workflow from article syndication. Value-first answers, no hard sell.

```mermaid
sequenceDiagram
    autonumber
    participant Cron as ParticipationCron<br/>(CRON_PARTICIPATION_SCHEDULE)
    participant Finder as QuestionFinder
    participant Camoufox as Camoufox Browser
    participant LLM as LlmService<br/>(15-provider router)
    participant Drafter as AnswerDrafter
    participant Judge as AnswerJudge
    participant DB as PostgreSQL
    participant Queue as BullMQ Queue<br/>(spa-posting-reddit/quora)
    participant Worker as BullMQ Worker
    participant Agent as BrowserAgentService<br/>(LLM-in-the-loop)
    participant Platform as Platform<br/>(Reddit/Quora)
    participant SSE as SSE Service
    participant Metrics as PostMetrics

    Note over Cron: Trigger: CRON_PARTICIPATION_SCHEDULE<br/>(default: 0 10 * * * — daily 10am)
    Cron->>Finder: findQuestions()

    Note over Finder,Camoufox: Phase 1: Search for questions
    Finder->>Camoufox: Browse Reddit (r/astrology, r/AskAstrologers, r/advancedastrology)
    Camoufox->>Platform: Navigate to subreddit search
    Platform-->>Camoufox: Question list
    Finder->>Camoufox: Browse Quora (astrology topics)
    Camoufox->>Platform: Navigate to Quora topic
    Platform-->>Camoufox: Question list

    Note over Finder,LLM: Phase 2: Filter relevant questions
    Finder->>LLM: Judge: is this question relevant to astrology niche?
    LLM-->>Finder: Relevance score + reasoning

    Note over Finder,DB: Phase 3: Dedup
    Finder->>DB: Check if question already answered<br/>(Post with contentType=ANSWER, sourceRef=question URL)
    DB-->>Finder: Not answered / already answered

    Note over Finder,Drafter: Phase 4: Draft answer
    Finder->>Drafter: draftAnswer(question, context)
    Drafter->>LLM: Write value-first answer<br/>(prompt: participation-answer-draft)
    Note over LLM: Genuinely helpful<br/>Reference blog only if natural<br/>No hard sell, no promotional language
    LLM-->>Drafter: Draft answer

    Note over Drafter,Judge: Phase 5: Judge answer
    Drafter->>Judge: judgeAnswer(draft, question)
    Judge->>LLM: Evaluate 4 criteria<br/>(prompt: participation-answer-judge)
    Note over LLM: helpfulness — does it answer the question?<br/>promotional_tone — must be < 0.3<br/>factual_accuracy — astrology facts correct?<br/>anti_ai_tone — sounds human?
    LLM-->>Judge: Scores (0.0-1.0 each)

    alt Judge score ≥ AUTO_APPROVE_MIN_SCORE_REDDIT (9, strictest)
        Judge->>DB: Save Post (status=APPROVED, contentType=ANSWER)
        Judge->>Queue: enqueuePosting(postId, network)
        Queue->>Queue: Concurrency=1, jobId=postId
    else Judge score < threshold
        Judge->>DB: Save Post (status=REJECTED)
        Judge-->>SSE: SSE: answer_rejected (low judge score)
    end

    Note over Worker,Platform: Phase 6: Post answer
    Queue->>Worker: Process job
    Worker->>DB: Re-check Post.status = APPROVED
    Worker->>Agent: act("navigate to question thread")
    Agent->>Camoufox: Screenshot + LLM vision
    Camoufox->>Platform: Navigate to question
    Agent->>Agent: verify("is this the question page?")
    Worker->>Agent: act("post answer in comment editor")
    Agent->>Camoufox: Screenshot + LLM identifies editor
    Camoufox->>Platform: Type answer (Markdown for Reddit, Rich text for Quora)
    Agent->>Agent: verify("is the answer visible on the page?")
    Platform-->>Camoufox: Answer posted

    Worker->>DB: Update Post.status = POSTED, set postUrl
    Worker->>SSE: SSE: answer_posted

    Note over Metrics: Phase 7: Track engagement
    loop Periodic metrics scraping
        Metrics->>Camoufox: Navigate to answer URL
        Camoufox->>Platform: Fetch answer page
        Platform-->>Camoufox: Upvotes, replies, views
        Metrics->>DB: Save PostMetrics (likes=upvotes, comments=replies)
    end

    Note over Metrics,DB: Phase 8: Engagement feedback loop
    Metrics->>DB: Query high-engagement answers
    Note over Metrics: High-engagement topics → feed back<br/>into topic selection for article generation<br/>(more articles on popular topics)
```

## Key details

### Participation vs syndication
- **Syndication** — push our articles to platforms (Dev.to, Hashnode, Medium, etc.)
- **Participation** — answer questions on forums (Reddit, Quora), create pins (Pinterest)
- Different workflow: question finding → answer drafting → strict judging → posting
- Same infrastructure: Camoufox, LlmService, BullMQ, SSE

### Value-first answers (critical for Reddit)
- **Genuinely helpful** — answer the question, provide value
- **Reference blog only if natural** — don't force links
- **No hard sell** — no promotional language, no "check out my blog"
- **Reddit is strictest** — `AUTO_APPROVE_MIN_SCORE_REDDIT=9` (vs 7 for other platforms)
- `promotional_tone` must be < 0.3 — anything higher is rejected

### Judge criteria (4 dimensions, 0.0-1.0)
| Criterion | What it checks | Threshold |
|-----------|---------------|-----------|
| `helpfulness` | Does it actually answer the question? | ≥ 0.7 |
| `promotional_tone` | Is it overly promotional? | < 0.3 (lower is better) |
| `factual_accuracy` | Are astrology facts correct? | ≥ 0.6 |
| `anti_ai_tone` | Does it sound human? | ≥ 0.7 |

### Question sources
- **Reddit:** r/astrology, r/AskAstrologers, r/advancedastrology (via Camoufox browse — Reddit API is paid)
- **Quora:** astrology topics (via Camoufox browse — Quora has no API for answers)
- **Pinterest:** not participation — pin creation from article covers (Phase 4 P4-07)

### Dedup
- Don't answer the same question twice
- `Post` with `contentType=ANSWER` + `sourceRef` pointing to question URL
- Query: `WHERE contentType = 'ANSWER' AND sourceRef.path = questionUrl`

### Engagement feedback loop
- Track which answers get high engagement (upvotes, replies)
- High-engagement topics → feed back into topic selection for article generation
- More articles on topics that generated engagement = content-market fit
- Stored in `PostMetrics` (existing model, reusing likes=upvotes, comments=replies)
