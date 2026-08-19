# Default prompt templates

This directory can hold domain-agnostic prompt markdown files. The
`DomainPromptFallbackProvider` loads `<name>.md` from `DOMAIN_PROMPT_DIR` and
interpolates it with brand/domain context.

## File format

A chat prompt is split by a line containing only `---`:

```markdown
You are a social media writer for {brandName}, {brandDescription}.
{brandVoice}

Return ONLY the requested output.
---
Topic: {topic}

Write a post:
```

A text prompt is a single markdown document.

## Prompt names used by the app

- `research-extract`
- `hook-generation`
- `draft-post`
- `critique-post`
- `refine-post`
- `judge` (single or batch)
- `topic-generation`
- `trending-relevance`
- `reply-decision`
- `comment-safety`
- `question-classifier`
- `engagement-decision`
- `article-research-extract`
- `article-outline`
- `article-draft`
- `article-judge`
- `article-refine`

Copy these from the built-in fallback prompts and customize for your domain.
