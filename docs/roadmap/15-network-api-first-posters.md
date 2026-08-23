# 15 · API-first network posters (Bluesky, Mastodon)

> **Feature:** `NETWORK-001` · **Task:** `NETWORK-101`
> **Status of this document:** specification (2026-08-23). Live task status lives only
> in [BACKLOG](../planning/BACKLOG.md); feature status only in
> [FEATURES](../planning/FEATURES.md).

## Transport decision

The standing SPA transport rule is applied per network:

> **Free official API → API. Stealth browser only where no free posting API exists.**

| Network | Transport | Rationale |
|---|---|---|
| Bluesky | Official **AT Protocol API** (`@atproto/api`) | Free, first-party, no anti-bot surface; browser automation adds ban risk with zero benefit |
| Mastodon | Official **Mastodon REST API** | Free, standard OAuth app tokens |
| Facebook, LinkedIn | Stealth browser (Camoufox) unchanged | No free posting API |
| X, Threads | Stealth browser unchanged (X API priced at ~$0.20/post → Hold) | Existing validated path |

Browser posters for Bluesky/Mastodon are **conserved behind a feature flag**
(`BLUESKY_TRANSPORT=api|browser`, `MASTODON_TRANSPORT=api|browser`), not deleted —
rollback without code change.

## Scope

1. `BlueskyApiPoster` — rich-text facet parsing (links/mentions), char limit 300,
   thread via `reply` chain, image attach when `MEDIA-001` lands, permalink from
   `commit.uri` + `cid`.
2. `MastodonApiPoster` — status POST with `visibility` setting, char limit from
   instance configuration (`/api/v1/instance`), thread via `in_reply_to_id`,
   permalink from returned `url`.
3. `domain/network-profiles/` registration: both networks get full `NetworkProfile`
   entries (`charLimit`, tone guidance, CTA policy, verification URL pattern) so
   generation and verification read the same source.
4. Verification: reuse the existing verify pipeline against the returned permalink;
   API transport verifies via GET on the status URI (cheaper than profile scrape).
5. Rate limiting through the existing per-network budget service (API-appropriate
   defaults; still respect instance-local limits).
6. Sessions model: API token stored in the existing encrypted `Session.storageState`
   shape or a dedicated credential field — decided at implementation, documented in
   the task evidence.

## Environment

```
BLUESKY_HANDLE=, BLUESKY_APP_PASSWORD=
MASTODON_BASE_URL=, MASTODON_ACCESS_TOKEN=
<NET>_TRANSPORT=api|browser   # default api for both new networks
```

## Acceptance / required evidence

- Per-network dry-run evidence (mocked API) plus one live post per network with a
  verified permalink — separately labelled local vs live, per repo evidence rules.
- No blanket "ready" claim across networks; each network is its own gate.
- Generation graph produces drafts for the new networks only after their
  `NetworkProfile` exists (single-source check).

## Non-goals

- No new browser automation work for these networks.
- No official-API work for Facebook/LinkedIn/X.
- No cross-posting dedup changes (SimHash path unchanged).
