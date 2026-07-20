# 02 — Per-Account Settings

## Status

Proposal. Today almost all configuration is global (`process.env` / `ConfigService`).

## Problem

The user wants "everything that can be customized" to be customizable **per account**. Currently:

- Rate limits, languages, auto-approve thresholds, brand voice, posting windows, visual styles, engagement limits, proxies, etc. are single global values.
- Different Threads accounts may target different countries/languages, post at different cadences, use different tones, or have different risk profiles.

## Product Outcome

Every configurable knob in SPA can be overridden at the account level. Settings inherit from global defaults, so nothing breaks if an account has no custom config.

## Settings Catalogue

| Category | Setting | Global env var today | Per-account purpose |
|----------|---------|----------------------|---------------------|
| Identity | `active` | `SOCIAL_{NETWORK}_ACTIVE` | Enable/disable this account |
| Identity | `warmupEnabled` | `SOCIAL_{NETWORK}_WARMUP` | New-account warm-up mode |
| Identity | `warmupDaysTotal` | `WARMUP_DAYS_TOTAL` | How long warm-up lasts |
| Auth | `credentialsRef` | `SOCIAL_*_USERNAME/PASSWORD` | Points to env var names |
| Auth | `cookies` | `SOCIAL_*_COOKIES` | Cookie string for session restore |
| Posting | `postingLanguage` | `POSTING_LANGUAGES` | Primary language for this account |
| Posting | `rateLimitDaily` | `RATE_LIMIT_{NETWORK}_MAX_PER_DAY` | Posts per day for this account |
| Posting | `rateLimitWeekly` | `RATE_LIMIT_{NETWORK}_MAX_PER_WEEK` | Posts per week for this account |
| Posting | `minDelayMs` | `RATE_LIMIT_MIN_DELAY_MS` | Minimum gap between posts |
| Posting | `postingTimezone` | — | Best-time-to-post timezone |
| Posting | `postingWindowHours` | — | Allowed posting hours, e.g. `9,10,11,19,20,21` |
| Approval | `autoApproveEnabled` | `AUTO_APPROVE_ENABLED` | Auto-approve for this account |
| Approval | `autoApproveMinScore` | `AUTO_APPROVE_MIN_SCORE` | Score threshold for auto-approve |
| Approval | `humanReviewRequired` | — | Force human review even if auto-approve is on |
| Content | `brandVoice` | `brand-voice.md` | Account-specific brand voice text |
| Content | `persona` | per-network persona | Network-specific persona override |
| Content | `bannedPhrases` | slop list | Additional banned words for this account |
| Content | `exampleSwipes` | fallback prompts | Example good/bad posts for prompts |
| Visuals | `imageGenerationEnabled` | `IMAGE_GENERATION_ENABLED` (future) | Enable images for this account |
| Visuals | `imageDailyLimit` | `IMAGE_GENERATION_DAILY_LIMIT` | Images per day for this account |
| Visuals | `imageModel` | `IMAGE_GENERATION_MODEL` | Gemini model for this account |
| Visuals | `imageResolution` | `IMAGE_GENERATION_RESOLUTION` | 0.5K/1K/2K/4K |
| Visuals | `imageStyle` | — | `quote_card`, `aesthetic_photo`, `chart_visualization` |
| Stealth | `proxyUrl` | `CAMOUFOX_PROXY_URL` | Per-account proxy |
| Stealth | `fingerprintProfile` | `CAMOUFOX_*` | Per-account fingerprint preset |
| Stealth | `browserLocale` | `CAMOUFOX_LOCALE` | e.g. `en-US`, `ru-RU` |
| Stealth | `browserTimezone` | — | e.g. `America/New_York` |
| Engagement | `engagementEnabled` | `ENGAGEMENT_ENABLED` | Enable engagement actions |
| Engagement | `engagementLimits` | `RATE_LIMIT_INTERACTION_*` | Per-account like/comment/follow budgets |

## Inheritance Model

Settings resolve in this order (later wins):

1. Hard-coded defaults in `AccountSettingsService`.
2. Global environment variables / `.env`.
3. Optional `AccountGroup` settings (Feature 01 group).
4. `SocialAccount.settings` JSON.

Example:

```ts
const settings = await accountSettingsResolver.resolve(accountId, {
  required: ['postingLanguage', 'rateLimitDaily'],
});
// returns merged, fully-typed settings
```

## Data Model

Add a JSONB `settings` column to `SocialAccount` (validated by a Zod schema in `packages/shared`) and a normalized view for queryable fields:

```prisma
model SocialAccount {
  // existing fields ...
  settings  Json?  // account-level overrides
}
```

Zod schema in `packages/shared/src/schemas/account-settings.ts`:

```ts
export const AccountSettingsSchema = z.object({
  active: z.boolean().optional(),
  postingLanguage: z.string().min(2).max(5).optional(),
  rateLimitDaily: z.number().int().min(0).optional(),
  rateLimitWeekly: z.number().int().min(0).optional(),
  minDelayMs: z.number().int().min(0).optional(),
  autoApproveEnabled: z.boolean().optional(),
  autoApproveMinScore: z.number().min(0).max(10).optional(),
  imageGenerationEnabled: z.boolean().optional(),
  imageDailyLimit: z.number().int().min(0).optional(),
  imageModel: z.string().optional(),
  imageResolution: z.enum(['0.5K','1K','2K','4K']).optional(),
  proxyUrl: z.string().url().optional(),
  browserLocale: z.string().optional(),
  postingTimezone: z.string().optional(),
  brandVoice: z.string().optional(),
  // ...
});
```

Using `packages/shared` keeps backend and UI in sync: changing the schema breaks both at compile time.

## Architecture

- New domain port `IAccountSettingsPort` (`packages/backend/src/domain/ports/account-settings.port.ts`).
- `AccountSettingsService` implements the port and resolves inheritance.
- `AccountSettingsResolver` caches per-account settings in Redis with a short TTL (60s) to avoid parsing JSON on every call.
- `AccountSettingsController` exposes `GET /accounts/:id/settings`, `PUT /accounts/:id/settings`.
- Env seeding (`AccountsService.seedFromEnv`) writes indexed env vars into `SocialAccount.settings` for parity.

## Service Integration

| Service | Change |
|---------|--------|
| `AccountsService` | Load and expose `settings`; merge with group/env |
| `GenerationService` | Pass account `brandVoice`, `postingLanguage`, `persona` to graph state |
| `PostingService` | Use account `rateLimitDaily/Weekly`, `minDelayMs`, `postingWindowHours` |
| `SessionsService` | Use account `proxyUrl`, `browserLocale`, `fingerprintProfile` |
| `RateLimitService` | Accept account-specific limits when constructing keys |
| `Orchestrator` | Use account `postingTimezone` and windows from `PostingWindowService` |
| `ImageGenerationService` | Use account `imageDailyLimit`, `imageModel`, `imageResolution` |

## UI / API Changes

- New tab "Settings" on the account detail page.
- Inheritance indicator: show which value is inherited and from where.
- "Copy settings from account" action.
- Bulk edit for `active`, `imageGenerationEnabled`, `postingLanguage`.

## Environment Variables for Seeding

To keep env-driven deployments possible, support:

```text
SOCIAL_THREADS_USERNAME_1=...
SOCIAL_THREADS_SETTINGS_1='{"postingLanguage":"ru","rateLimitDaily":3,"imageDailyLimit":2,"proxyUrl":"http://..."}'
```

A single `*_SETTINGS_{N}` JSON blob is easier to maintain than one env var per field.

## Security / Reliability

- Never store actual passwords or API keys in `settings`; only `credentialsRef` (env var name).
- Validate `proxyUrl`, `browserLocale`, `postingTimezone` before saving.
- `RedactInterceptor` already strips `storageState` and credentials from logs; ensure `settings` is also redacted if it contains `proxyUrl` with embedded auth.

## Acceptance Criteria

- [ ] `AccountSettingsSchema` lives in `packages/shared` and is used by backend and UI.
- [ ] `IAccountSettingsPort` and `AccountSettingsService` resolve inheritance.
- [ ] All rate-limit calls use account-specific limits.
- [ ] `GenerationService` can inject account-level `brandVoice`/`persona`.
- [ ] `ImageGenerationService` respects `imageDailyLimit` and `imageModel` per account.
- [ ] `SessionsService` picks proxy/fingerprint from account settings.
- [ ] UI allows editing and shows inheritance.
- [ ] Existing global env continues to work without per-account settings.

## Open Questions

- Should settings be versioned (audit log) so operators can roll back a bad config?
- Should some fields be locked at the `AccountGroup` level (e.g. proxy for a group of client accounts)?
- Should we generate a default `brandVoice` per language automatically if none is set?

## Effort Estimate

**M** (1-2 weeks). Mostly plumbing: schema, resolver, controller, service wiring, and UI form. The complexity is in making every consumer use the resolver instead of raw `ConfigService`.

## Related Internal Docs

- `docs/reviews/accounts.md`
- `packages/backend/src/modules/accounts/accounts.service.ts`
- `packages/backend/src/modules/rate-limit/rate-limit.service.ts`
- `packages/backend/src/modules/generation/generation.service.ts`
