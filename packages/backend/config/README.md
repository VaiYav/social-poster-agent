# Domain config

This directory contains example configuration files for the domain-agnostic
Social Poster Agent. Copy these `.example.*` files (or the `default/` prompt
templates) and customize them for your own brand and topic area.

| File | Purpose |
|------|---------|
| `brand-voice.md` | Your brand voice guidelines. Not committed; copy from `../../brand-voice.example.md`. |
| `content-pillars.example.json` | Content pillar definitions for the rotation tracker. |
| `content-styles.example.json` | Post styles and prompt guidance. |
| `humor-mechanics.example.json` | Humor mechanics for the humor layer. |
| `slop-lexicon.example.json` | Language-specific words/phrases that lower anti-AI tone. |
| `trending-niches.example.json` | Keywords that define which scraped trends are relevant. |
| `trending-events.example.json` | Calendar of domain-specific recurring events. |
| `trending-keyword-overrides.example.json` | Blocklist keyword context overrides. |
| `visual-styles.example.json` | Visual concept styles for image generation. |

To use a file, copy or rename it to remove `.example` and set the matching
`*_PATH` environment variable in `.env`.
