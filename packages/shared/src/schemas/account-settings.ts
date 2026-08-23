// Per-account settings schema (ROADMAP_V2 M1.2 / docs/roadmap/02).
// Shared between backend (validation + inheritance resolution) and UI
// (settings tab + inheritance indicators). Changing this file breaks both at
// compile time — by design.
//
// Inheritance chain (later wins): hard defaults → global env → account JSON.
// All fields optional: absence means "inherit from the previous layer".

import { z } from "zod";

export const AccountSettingsSchema = z.object({
  // ── Identity ──
  /** Enable/disable this account independently of SOCIAL_{NETWORK}_ACTIVE. */
  active: z.boolean().optional(),

  // ── Posting ──
  rateLimitDaily: z.number().int().min(0).optional(),
  rateLimitWeekly: z.number().int().min(0).optional(),
  /** Minimum gap between consecutive posts (ms). */
  minDelayMs: z.number().int().min(0).optional(),
  /** Allowed posting hours (UTC 0-23), e.g. [9, 10, 19, 20]. */
  postingWindowHours: z.array(z.number().int().min(0).max(23)).max(24).optional(),
  /** IANA timezone for best-time-to-post calculations. */
  postingTimezone: z.string().max(64).optional(),

  // ── Approval ──
  autoApproveEnabled: z.boolean().optional(),
  autoApproveMinScore: z.number().min(0).max(10).optional(),
  /** Force human review even when auto-approve would pass this post. */
  humanReviewRequired: z.boolean().optional(),

  // ── Content / brand voice (M1.3 consumes these) ──
  brandVoice: z.string().max(20000).optional(),
  persona: z.string().max(5000).optional(),
  /** Extra banned phrases layered on top of the global slop lexicon. */
  bannedPhrases: z.array(z.string().min(1).max(100)).max(200).optional(),
  exampleSwipes: z.array(z.string().min(1).max(1000)).max(50).optional(),

  // ── Visuals (consumed by image gen in M4.2) ──
  imageGenerationEnabled: z.boolean().optional(),
  imageDailyLimit: z.number().int().min(0).optional(),
  imageCostBudgetUsdPerDay: z.number().min(0).optional(),
  imageModel: z.string().max(100).optional(),
  imageResolution: z.enum(["0.5K", "1K", "2K", "4K"]).optional(),
  imageStyle: z.enum(["quote_card", "aesthetic_photo", "chart_visualization"]).optional(),

  // ── Stealth ──
  proxyUrl: z.string().max(500).optional(),
  browserLocale: z.string().max(35).optional(),
  browserTimezone: z.string().max(64).optional(),

  // ── Engagement ──
  engagementEnabled: z.boolean().optional(),
});

export type AccountSettings = z.infer<typeof AccountSettingsSchema>;

/** Where each resolved value came from — powers UI inheritance indicators. */
export type AccountSettingsSource = "default" | "env" | "account";

/** Fully-resolved settings (no undefined) plus per-key provenance. */
export interface ResolvedAccountSettings {
  values: Required<AccountSettings>;
  sources: Record<keyof AccountSettings, AccountSettingsSource>;
}
