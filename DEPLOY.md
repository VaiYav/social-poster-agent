# SPA — Private deploy repo (my-zodiac-ai)

This is the private, deployable fork of the public [`VaiYav/social-poster-agent`](https://github.com/VaiYav/social-poster-agent) project. It contains the same open-source code plus the My Zodiac AI domain files that must not be public.

## What lives here (private)

- `brand-voice.md` — the brand voice for My Zodiac AI.
- `CONSTITUTION.md`, `FEATURE_WISHLIST.md`, `ROADMAP.md` — internal design docs.
- `docs/` — ADRs, runbooks, audits, research, and roadmap docs.
- `packages/backend/config/*.json` — real (non-example) domain configs: content pillars, trending niches/events, humor mechanics, slop lexicon, visual styles, etc. These override the generic defaults at runtime via the `*_PATH` env variables.

## What lives in the public repo

All source code, tests, CI, and generic examples live in `https://github.com/VaiYav/social-poster-agent`. This repo tracks that as `upstream`.

## Updating from upstream

```bash
git fetch upstream
git checkout prod
git merge upstream/main
# resolve .gitignore/README conflicts if any, then push
git push origin prod
```

## Railway deployment

Railway builds from the repo root `Dockerfile` and reads env variables from the Railway project dashboard.

### File paths inside the container

The `Dockerfile` copies the repo to `/app`. The working directory at runtime is `/app`. Domain files should be placed in:

```text
/app/brand-voice.md
/app/packages/backend/config/content-pillars.json
/app/packages/backend/config/content-styles.json
/app/packages/backend/config/humor-mechanics.json
/app/packages/backend/config/slop-lexicon.json
/app/packages/backend/config/trending-niches.json
/app/packages/backend/config/trending-events.json
/app/packages/backend/config/visual-styles.json
/app/packages/backend/config/trending-keyword-overrides.json
/app/packages/backend/config/prompts/*.md
```

### Recommended env values for Railway

```bash
BRAND_NAME=My Zodiac AI
BRAND_DESCRIPTION=an AI-powered astrology and natal chart assistant
DOMAIN=astrology, natal charts, horoscopes, zodiac

# Paths are relative to /app (WORKDIR in Dockerfile)
BRAND_VOICE_PATH=brand-voice.md
DOMAIN_PROMPT_DIR=packages/backend/config/prompts

# Optional JSON overrides (create the files from the .example.json templates)
CONTENT_PILLARS_PATH=packages/backend/config/content-pillars.json
CONTENT_STYLES_PATH=packages/backend/config/content-styles.json
HUMOR_MECHANICS_PATH=packages/backend/config/humor-mechanics.json
SLOP_LEXICON_PATH=packages/backend/config/slop-lexicon.json
TRENDING_NICHES_PATH=packages/backend/config/trending-niches.json
TRENDING_EVENTS_PATH=packages/backend/config/trending-events.json
VISUAL_STYLES_PATH=packages/backend/config/visual-styles.json

# Plus the usual production env: DATABASE_URL, REDIS_URL, social credentials, LLM keys, etc.
# See the public repo .env.example for the full list.
```

### Containerized brand / domain data

If you want to store all prompt and config files in `packages/backend/config/` (where the Dockerfile already copies `packages/backend/`), you do not need to touch the `Dockerfile`. If you prefer a root `config/` directory, add a `COPY config/ ./config/` line to the root `Dockerfile`.
