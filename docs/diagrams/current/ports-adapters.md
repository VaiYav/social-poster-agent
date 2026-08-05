# Hexagonal Ports & Adapters — Current State

> **Architecture:** How SPA's domain core stays infra-free via Symbol-token DI ports.
> **As-is:** 6 ports declared as `Symbol()` in `domain/ports/*.ts`, bound to adapters in infra modules.

```mermaid
flowchart LR
    %% ===== Ports (left) — Symbol DI tokens =====
    subgraph Ports["Ports (domain/ports/*.ts — Symbol DI tokens)"]
        direction TB
        ILlmPort["ILlmPort<br/>Symbol()"]
        IBrowserPort["IBrowserPort<br/>Symbol()"]
        IContentPort["IContentPort<br/>Symbol()"]
        IEngagementDecisionPort["IEngagementDecisionPort<br/>Symbol()"]
        IPostingQueuePort["IPostingQueuePort<br/>Symbol()"]
        IPromptPort["IPromptPort<br/>Symbol()"]
    end

    %% ===== Domain Core (center hexagon) =====
    subgraph Domain["Domain Core (no infra imports)"]
        direction TB
        GenerationService["GenerationService<br/>@Inject(ILlmPort)<br/>@Inject(IPromptPort)"]
        PostingService["PostingService<br/>@Inject(IBrowserPort)<br/>@Inject(IPostingQueuePort)"]
        EngagementService["EngagementService<br/>@Inject(IEngagementDecisionPort)"]
        OrchestratorService["OrchestratorService<br/>@Inject(ILlmPort)"]
        RepliesService["RepliesService<br/>@Inject(IEngagementDecisionPort)"]
        ContentEnhancements["ContentEnhancementsService<br/>@Inject(IContentPort)"]
    end

    %% ===== Adapters (right) — bound in infra modules =====
    subgraph Adapters["Adapters (infra modules — provider bindings)"]
        direction TB
        LlmService["LlmService<br/>15-provider router<br/>{ provide: ILlmPort, useExisting: LlmService }"]
        BrowserFactory["BrowserFactory<br/>Camoufox (Firefox)<br/>{ provide: IBrowserPort, useExisting: BrowserFactory }"]
        ContentReader["ContentReader<br/>CAP disk + DB<br/>{ provide: IContentPort, useExisting: ContentReader }"]
        EngagementDecision["EngagementDecisionService<br/>{ provide: IEngagementDecisionPort, useExisting }"]
        QueueFactory["QueueFactory<br/>BullMQ<br/>{ provide: IPostingQueuePort, useFactory }"]
        PromptRegistry["PromptRegistry<br/>Langfuse (5-min cache)<br/>{ provide: IPromptPort, useExisting: PromptRegistry }"]
    end

    %% ===== External systems (far right) =====
    subgraph External["External systems"]
        direction TB
        LLMProviders["LLM Providers<br/>(15 OpenAI-compatible)"]
        Platforms["Camoufox → X / Threads / Facebook"]
        CAPRepo["CAP repo on disk<br/>(../content-agent-platform)"]
        Langfuse["Langfuse<br/>prompt mgmt + tracing"]
        Redis["Redis<br/>(BullMQ queues)"]
    end

    %% Domain services inject ports (left arrows)
    GenerationService --> ILlmPort
    GenerationService --> IPromptPort
    PostingService --> IBrowserPort
    PostingService --> IPostingQueuePort
    EngagementService --> IEngagementDecisionPort
    OrchestratorService --> ILlmPort
    RepliesService --> IEngagementDecisionPort
    ContentEnhancements --> IContentPort

    %% Ports bound to adapters in infra modules (right arrows)
    ILlmPort -.->|bound in LlmModule| LlmService
    IBrowserPort -.->|bound in BrowserModule| BrowserFactory
    IContentPort -.->|bound in ContentModule| ContentReader
    IEngagementDecisionPort -.->|bound in EngagementModule| EngagementDecision
    IPostingQueuePort -.->|bound in QueueModule| QueueFactory
    IPromptPort -.->|bound in PromptRegistryModule| PromptRegistry

    %% Adapters → external systems
    LlmService --> LLMProviders
    BrowserFactory --> Platforms
    ContentReader --> CAPRepo
    PromptRegistry --> Langfuse
    QueueFactory --> Redis

    classDef port fill:#e3f2fd,stroke:#1565c0,stroke-width:2px,color:#000
    classDef domain fill:#fff3e0,stroke:#e65100,stroke-width:2px,color:#000
    classDef adapter fill:#e8f5e9,stroke:#2e7d32,stroke-width:2px,color:#000
    classDef external fill:#f3e5f5,stroke:#6a1b9a,stroke-width:2px,color:#000

    class ILlmPort,IBrowserPort,IContentPort,IEngagementDecisionPort,IPostingQueuePort,IPromptPort port
    class GenerationService,PostingService,EngagementService,OrchestratorService,RepliesService,ContentEnhancements domain
    class LlmService,BrowserFactory,ContentReader,EngagementDecision,QueueFactory,PromptRegistry adapter
    class LLMProviders,Platforms,CAPRepo,Langfuse,Redis external
```

## Key details

### 6 ports as `Symbol()` DI tokens
- **`ILlmPort`** (`domain/ports/llm.port.ts`) — LLM generation. Bound to `LlmService` (15-provider router) in `LlmModule`.
- **`IBrowserPort`** (`domain/ports/browser.port.ts`) — browser automation. Bound to `BrowserFactory` (Camoufox) in `BrowserModule`.
- **`IContentPort`** (`domain/ports/content.port.ts`) — content source. Bound to `ContentReader` (CAP disk + DB) in `ContentModule`.
- **`IEngagementDecisionPort`** (`domain/ports/engagement-decision.port.ts`) — engagement decisions. Bound to `EngagementDecisionService` in `EngagementModule` (feature-flagged).
- **`IPostingQueuePort`** (`domain/ports/posting-queue.port.ts`) — posting queue. Bound via `useFactory` to `QueueFactory` (BullMQ) in `QueueModule`.
- **`IPromptPort`** (`domain/ports/prompt.port.ts`) — prompt registry. Bound to `PromptRegistry` (Langfuse) in `PromptRegistryModule` (`@Global`).

### Hexagonal pattern
- Domain services `@Inject(SYMBOL)` — never the concrete class. Unit tests inject a mock `ILlmPort` / `IBrowserPort` etc.
- **To swap an adapter, change only the provider binding** in the infra module (e.g. `{ provide: ILlmPort, useExisting: MockLlmService }`).
- **Domain never imports infra** — `src/domain/` contains only port interfaces and re-exports of shared types. No `import` from `infrastructure/` or `modules/` appears in `domain/`.
- Ports live in `domain/ports/*.ts`; the barrel `domain/ports/index.ts` re-exports all 6.
- Bindings live in infra modules (`LlmModule`, `BrowserModule`, `ContentModule`, `PromptRegistryModule`, `QueueModule`, `EngagementModule`).
- Feature-flagged ports (`IEngagementDecisionPort`, `IBrowsingSessionPort`, `IRepliesMonitorPort`) are bound via `useExisting` only when their feature flag is on — otherwise the token is unresolvable and dependent services must be absent too.
