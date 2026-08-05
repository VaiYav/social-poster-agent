# LLM-in-the-Loop Browser Interaction — Future State

> **Flow diagram:** How the LLM vision-based browser engine works (browser-use / Stagehand pattern).
> **To-be:** No hardcoded CSS selectors — LLM resolves elements at runtime via screenshots + DOM context.

```mermaid
flowchart TD
    Entry([Poster calls<br/>browserAgent.act instruction]) --> Screenshot[Step 1<br/>Screenshot page<br/>Camoufox page.screenshot]
    Screenshot --> DOM[Step 2<br/>Extract DOM context<br/>Simplified accessibility tree]
    DOM --> LLM[Step 3<br/>Send to LlmService<br/>screenshot + DOM + instruction<br/>via free-first 15-provider router]
    LLM --> Parse[Step 4<br/>Parse LLM response<br/>action type + target + params]
    Parse --> Execute{Step 5<br/>Execute action via Camoufox}

    Execute -->|click| Click[humanClick locator]
    Execute -->|type| Type[humanType locator text]
    Execute -->|scroll| Scroll[scrollPage page direction]
    Execute -->|navigate| Nav[page.goto url]
    Execute -->|wait| Wait[page.waitForTimeout]

    Click --> Verify{Step 6<br/>Task complete?}
    Type --> Verify
    Scroll --> Verify
    Nav --> Verify
    Wait --> Verify

    Verify -->|verify stateDescription| CheckState[LLM verify call<br/>screenshot → boolean]
    CheckState -->|true| Done([Return success])
    CheckState -->|false| Screenshot

    Verify -->|max iterations reached| Fail([Return failure<br/>BullMQ retry handles])

    %% Error paths
    LLM -->|misread / hallucination| Retry[LLM misread<br/>BullMQ retry re-queues job]
    Retry --> Screenshot

    %% Other primitives
    subgraph Other Primitives
        Extract[extract schema<br/>screenshot + DOM → LLM<br/>→ structured data<br/>Zod-validated]
        Observe[observe<br/>screenshot + DOM → LLM<br/>→ list of actionable elements]
        VerifyCall[verify stateDescription<br/>screenshot → LLM<br/>→ boolean]
    end

    %% Integration
    subgraph LlmService Integration
        Router[Free-first router<br/>Groq → SambaNova → Cerebras<br/>→ OpenRouter → ... → Ollama]
        Cache[5-min SHA256 cache<br/>identical screenshots skip LLM]
        CB[Circuit breaker<br/>3 failures → 1 min cooldown]
        Temp[temperature=0<br/>for vision tasks]
    end

    Llm -.-> Router
    Llm -.-> Cache
    Llm -.-> CB
    Llm -.-> Temp

    %% Fallback
    subgraph Safety Net
        LoginFallback[Login flows<br/>fall back to selector-based<br/>determinism matters]
    end

    Retry -.->|critical path| LoginFallback

    classDef step fill:#e3f2fd,stroke:#1976d2,stroke-width:2px,color:#000
    classDef decision fill:#fff3e0,stroke:#f57c00,stroke-width:2px,color:#000
    classDef terminal fill:#e8f5e9,stroke:#388e3c,stroke-width:2px,color:#000
    classDef error fill:#ffebee,stroke:#d32f2f,stroke-width:2px,color:#000
    classDef integration fill:#f3e5f5,stroke:#7b1fa2,stroke-width:2px,color:#000
    classDef safety fill:#e0f7fa,stroke:#00838f,stroke-width:2px,color:#000

    class Screenshot,DOM,LLM,Parse,Click,Type,Scroll,Nav,Wait,CheckState step
    class Execute,Verify decision
    class Entry,Done terminal
    class Fail,Retry error
    class Router,Cache,CB,Temp,Extract,Observe,VerifyCall integration
    class LoginFallback safety
```

## Key details

### Pattern: browser-use / Stagehand / Skyvern
- **browser-use** (107K stars, Python) — `observe → think → act` loop. Screenshot → LLM decides next action.
- **Stagehand** (TypeScript) — 4 primitives: `act("click submit")`, `extract`, `observe`, `agent`. "Instructions survive page redesigns."
- **Skyvern** (Python) — `page.click(prompt="Click login button")` instead of `page.click("#btn")`. "Resistant to website layout changes."
- **AgentQL** — AI query language, natural language selectors, self-healing.

### IBrowserPort methods (P0-02 stubs, P1-00 real impl)
- **`act(instruction: string)`** — "Click the Publish button", "Find the canonical URL field and type X"
- **`extract(schema: ZodSchema)`** — extract structured data from page via LLM vision (Zod-validated)
- **`observe()`** — return list of actionable elements on page (LLM-resolved, not CSS-parsed)
- **`verify(stateDescription: string)`** — "Is the article published? yes/no" → boolean

### Trade-offs vs selector-based
| Parameter | Selector-based | LLM-in-the-loop |
|-----------|---------------|-----------------|
| Maintenance | High (drift) | **Zero** |
| Speed | 5-10 sec/post | 30-90 sec/post (LLM thinking) |
| Cost | $0 | ~$0 (free-first router + cache) |
| Reliability | 95% (when selectors work) | 85-90% (LLM can misread) |
| Determinism | Yes | No (LLM stochastic) |

### Mitigations
- **Speed:** BullMQ queue, concurrency=1, no real-time requirement. 30-90 sec is fine.
- **Cost:** Free-first router (Groq → SambaNova → Cerebras → ... → Ollama). 5-min SHA256 cache. Circuit breaker per provider.
- **Reliability:** Retry on LLM misread (BullMQ retry). Fallback to selector-based for critical paths (login flow).
- **Determinism:** temperature=0 for vision tasks where possible.

### Phase 5 migration (#48)
- Existing X/Threads/Facebook posters keep selector chain for now (it works, don't break it)
- Migrate to LLM-in-the-loop in Phase 5 as a separate task
- Order: Facebook (persistent context, simplest) → Threads → X (most complex)
- Keep selector chain as fallback safety net for login flows (determinism matters)
