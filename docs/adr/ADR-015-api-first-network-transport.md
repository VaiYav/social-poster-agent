# ADR-015: API-first transport for Bluesky and Mastodon

**Status:** Accepted  
**Date:** 2026-08-23  
**Feature/task:** `NETWORK-001` / `NETWORK-101`

## Decision

Use free official posting APIs by default where they exist:

- Bluesky uses the AT Protocol `com.atproto.server.createSession` and
  `com.atproto.repo.createRecord` endpoints.
- Mastodon uses the instance REST API (`/api/v1/instance` and `/api/v1/statuses`).
- Facebook, LinkedIn, X and Threads keep their existing browser transport.

The existing Bluesky/Mastodon browser posters are retained behind explicit rollback switches:
`BLUESKY_TRANSPORT=browser` and `MASTODON_TRANSPORT=browser`. Any other value, including an
unset value, selects `api`.

## Credential and safety boundary

- Bluesky API credentials use the existing `BLUESKY_HANDLE` and
  `BLUESKY_APP_PASSWORD` settings; the session JWT is held in memory only.
- Mastodon API credentials use `MASTODON_ACCESS_TOKEN`; the token is sent only to the configured
  instance origin.
- `SPA_DRY_RUN=true` returns deterministic synthetic permalinks and never calls a provider.
- API posters reuse the canonical network profiles for limits and the posting service's existing
  rate-limit/flow/policy gates.
- API permalinks are verified through the provider's read endpoint before `POST_VERIFIED`.

## Consequences

API transport removes browser/selector and anti-bot risk for these two networks, but requires
provider credentials, instance/API availability and separate live-permalink evidence. Rich-text
facets are encoded as UTF-8 byte ranges; Mastodon character limits are discovered from the
instance configuration with the profile default as a bounded fallback.

## Rollback

Set the affected `*_TRANSPORT` variable to `browser` and restart the service. No data migration or
credential rewrite is required.
