# Architecture Diagrams

Visual documentation of the Social Poster Agent (SPA) architecture — current and future state.

## Directory structure

```
docs/diagrams/
├── README.md                    # This file — index of all diagrams
├── current/                     # As-is architecture (what exists today)
│   ├── c4-context.md           # C4 Level 1 — system context
│   ├── c4-container.md         # C4 Level 2 — containers
│   ├── module-dependency.md    # NestJS module dependency graph
│   ├── ports-adapters.md       # Hexagonal ports & adapters
│   ├── generation-graph.md     # LangGraph generation flow
│   ├── posting-sequence.md     # End-to-end posting sequence
│   ├── er-diagram.md           # Prisma ER diagram
│   └── llm-router.md           # LLM provider fallback chain
├── future/                      # To-be architecture (syndication feature)
│   ├── c4-context.md           # C4 Level 1 — with 11 platforms
│   ├── c4-container.md         # C4 Level 2 — with new services
│   ├── module-dependency.md    # Extended module graph
│   ├── article-graph.md        # Article generation LangGraph
│   ├── syndication-sequence.md # Full syndication flow
│   ├── llm-in-the-loop.md      # LLM vision browser interaction
│   ├── participation-flow.md   # Reddit/Quora participation
│   ├── phase-roadmap.md        # Phase 0-5 Gantt
│   └── er-diagram.md           # Extended ER diagram
└── structurizr/
    ├── workspace.dsl           # Structurizr DSL — single model, multiple views
    └── README.md               # How to render
```

## Diagram types

| Type | Tool | Where | Notes |
|------|------|-------|-------|
| C4 Context/Container | Mermaid (C4 syntax) | `current/`, `future/` | GitHub renders natively |
| Module dependency | Mermaid flowchart | `current/`, `future/` | GitHub renders natively |
| LangGraph flows | Mermaid + LangGraph Studio | `current/`, `future/` | Studio for interactive view |
| Sequence diagrams | Mermaid sequence | `current/`, `future/` | GitHub renders natively |
| ER diagrams | Mermaid erDiagram | `current/`, `future/` | GitHub renders natively |
| Phase roadmap | Mermaid gantt | `future/` | GitHub renders natively |
| Complex sequence | PlantUML → PNG | `future/syndication-sequence.md` | Rendered to PNG, committed |

## Rendering

All Mermaid diagrams render natively in GitHub Markdown. No external tools needed to view.

For Structurizr DSL (`structurizr/workspace.dsl`):
```bash
# Install Structurizr CLI
brew install structurizr-cli

# Render to Mermaid
structurizr export -workspace docs/diagrams/structurizr/workspace.dsl -format mermaid
```

For LangGraph Studio (interactive graph visualization):
```bash
# Already configured in the project
# Open LangGraph Studio, point to packages/backend
# Graph auto-visualizes from code
```

## Priority

| Priority | Diagrams | When needed |
|----------|----------|-------------|
| **P0 — now** | C4 Context (current), C4 Container (current), Generation graph, Posting sequence | Before starting syndication work |
| **P1 — before Phase 0** | C4 Context (future), C4 Container (future), Article graph, Syndication sequence, Phase roadmap | Before implementation |
| **P2 — before Phase 1** | LLM-in-the-loop flow, Module graph (future), Ports & Adapters | Before LLM engine implementation |
| **P3 — ongoing** | Module graph (current), ER (current), LLM router, Participation flow, ER (future) | Reference documentation |
