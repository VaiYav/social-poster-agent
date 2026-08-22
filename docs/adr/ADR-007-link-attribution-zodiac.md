# ADR-007: Link Attribution via my_zodiac_ai/back (Z4 Lead Funnel)

**Status:** Accepted
**Date:** 2026-08-22
**Decider:** Valentyn Yakovliev
**Supersedes:** ROADMAP_V1 P10 source-attribution sketch (source-url.util.ts revived as fallback core)
**Related:** ROADMAP_V2.md §Z4, §M0, §M2-M3

## Context

ROADMAP_V2 makes lead generation the primary product goal. Posts must carry
**measurable CTA links**, but the social-poster-agent has no link infrastructure:

- Generation prompts forbid URLs outright (fallback-prompts.ts, generation.service.ts)
- `source-url.util.ts` (P10) is dead code; `CanonicalUrlService` covers POSSE SEO only
- No click tracking, no conversion attribution — leads are unmeasurable today

Building our own redirector/shortener/click-store was scoped out (ROADMAP_V2 §7
Non-goals): the sibling project **my_zodiac_ai/back** already ships a production
attribution stack (`modules/business/attribution-links`, Wave #213):

- `AttributionLink`: slug → `{platform(=utm_source), medium, campaign, content,
  refTag, customFields}`, `destinationUrl` allowlisted to `*.my-zodiac-ai.com`
- `AttributionClick`: per-click record with geo/device/ipHash and a stitch key
  (`quizSessionId`) that carries attribution through click → quiz session →
  snapshot → **payment** (conversion writeback incl. revenue)
- Admin API `/api/v2/admin/attribution-links` + per-link funnel reports

The quiz funnel (`quiz.my-zodiac-ai.com/r/<slug>`) is the primary lead surface —
exactly where post CTAs should land.

### Transport decision

Service-to-service access options were JWT service account vs direct MongoDB vs
internal token. Chosen: **internal-token endpoint** in zodiac-back, reusing its
existing `MAIN_BACKEND_INTERNAL_TOKEN` pattern — stable credentials, no password
rotation, no schema coupling.

## Decision

1. **No link infrastructure of our own.** Social-poster-agent becomes a *client*
   of zodiac-back attribution links. Redirects, click records and conversions
   live entirely in zodiac-back.

2. **Domain port first.** Consumers depend on `ILinkPort`
   (`src/domain/ports/link.port.ts`, Symbol DI token), never on an HTTP client:
   - `createTrackableLink({network, campaign, postId?, accountHandle?, destinationUrl?})`
   - `getFunnelReport(linkId, {from?, to?})`

   Adapter: `ZodiacLinkClient` (infrastructure/link/, M2.1) over
   `POST/GET {ZODIAC_API_URL}/internal/attribution-links` with
   `X-Internal-Token: ZODIAC_INTERNAL_TOKEN`. The internal controller in
   zodiac-back is a thin pass-through to the existing `AttributionLinksService`.

3. **Posting is never blocked by the link service.** Graceful degradation ladder:
   - zodiac-back reachable → short link stored on `Post.ctaUrl`,
     `Post.attributionLinkId/attributionSlug` set
   - unreachable / timeout / non-2xx → `LinkServiceUnavailableError` → caller
     falls back to `buildDirectUtmUrl()`
     (`modules/content-enhancements/source-url.util.ts`, revived P10 core) —
     plain UTM-tagged destination URL; `attributionLinkId = null`
   - every degradation is logged as a structured event for the reliability dashboard

4. **Fallback UTM builder contract.** Deterministic param order
   (utm_source → medium → campaign → content), preserves existing query params,
   rejects non-http(s) destinations at build time. Same inputs ⇒ byte-identical
   URLs (SimHash/dedup stability).

5. **Schema.** `Post` gains three nullable columns (migration
   `20260822000000_add_post_link_attribution`): `ctaUrl`, `attributionLinkId`,
   `attributionSlug` (+ index). No `LeadEvent` model — clicks/conversions are
   read back from zodiac-back funnel reports (M2.4 dashboard).

6. **Env surface** (validated in `env.validation.ts`): `ZODIAC_API_URL` (empty =
   port disabled, always fallback), `ZODIAC_INTERNAL_TOKEN`,
   `ZODIAC_DEFAULT_DESTINATION_URL` (default `https://quiz.my-zodiac-ai.com`),
   `ZODIAC_TIMEOUT_MS` (default 5000).

## Consequences

**Positive**
- Leads measurable end-to-end down to *paid conversions*, not just clicks
- Zero new redirect/click infrastructure to operate or secure
- Posting pipeline decoupled from link-service availability
- Port-based design keeps M2.1 adapter swappable and trivially mockable

**Negative / risks**
- Cross-project deployment dependency (zodiac-back must expose the internal
  endpoint before M2.1 goes live) — mitigated by the fallback path
- Click records TTL is 30 days in zodiac-back; long-horizon analytics require
  periodic snapshotting into the conversion dashboard (noted in M2.4)
- `destinationUrl` allowlist means posts can only drive traffic to
  `*.my-zodiac-ai.com` properties — intentional: that is the lead goal

**Neutral**
- X policy stays "link in first reply" (M2.3 `postWithReplyLink()`); Threads/FB
  may inline the CTA — prompt-level concern, not transport
