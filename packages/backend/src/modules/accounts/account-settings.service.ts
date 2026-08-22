// AccountSettingsService — resolves per-account settings through the
// inheritance chain (ROADMAP_V2 M1.2 / docs/roadmap/02):
//
//   hard defaults → global env → SocialAccount.settings JSON
//
// All layers are validated by AccountSettingsSchema (@spa/shared) so the UI
// and backend share one contract. Group-level settings (AccountGroup) are a
// planned layer — the chain below has an explicit insertion point for them.

import { Injectable, Logger, NotFoundException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import {
  AccountSettingsSchema,
  type AccountSettings,
  type AccountSettingsSource,
  type ResolvedAccountSettings,
} from "@spa/shared";
import { PrismaService } from "../../infrastructure/prisma/prisma.service";

/** Hard defaults — layer 0 of the chain. Mirrors current env defaults. */
const HARD_DEFAULTS: Required<AccountSettings> = {
  active: true,
  postingLanguage: "en",
  rateLimitDaily: 1,
  rateLimitWeekly: 5,
  minDelayMs: 300_000,
  postingWindowHours: [],
  postingTimezone: "UTC",
  autoApproveEnabled: false,
  autoApproveMinScore: 7,
  humanReviewRequired: false,
  brandVoice: "",
  persona: "",
  bannedPhrases: [],
  exampleSwipes: [],
  imageGenerationEnabled: false,
  imageDailyLimit: 0,
  imageModel: "",
  imageResolution: "1K",
  imageStyle: "quote_card",
  proxyUrl: "",
  browserLocale: "en-US",
  browserTimezone: "UTC",
  engagementEnabled: false,
};

@Injectable()
export class AccountSettingsService {
  private readonly logger = new Logger(AccountSettingsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly configService: ConfigService,
  ) {}

  /**
   * Resolve the full settings object for an account, merging every layer and
   * reporting where each value came from (UI inheritance indicators).
   * Throws NotFoundException when the account does not exist.
   */
  async resolve(accountId: string): Promise<ResolvedAccountSettings> {
    const account = await this.prisma.socialAccount.findUnique({
      where: { id: accountId },
      select: { id: true, network: true, settings: true },
    });
    if (!account) throw new NotFoundException(`Account ${accountId} not found`);

    const envLayer = this.envLayer(account.network);
    const accountLayer = AccountSettingsSchema.parse(account.settings ?? {});

    const values = { ...HARD_DEFAULTS } as Required<AccountSettings>;
    const sources = {} as Record<keyof AccountSettings, AccountSettingsSource>;
    for (const key of Object.keys(HARD_DEFAULTS) as Array<keyof AccountSettings>) {
      sources[key] = "default";
    }

    for (const [key, value] of Object.entries(envLayer)) {
      if (value !== undefined) {
        (values as Record<string, unknown>)[key] = value;
        sources[key as keyof AccountSettings] = "env";
      }
    }
    for (const [key, value] of Object.entries(accountLayer)) {
      if (value !== undefined) {
        (values as Record<string, unknown>)[key] = value;
        sources[key as keyof AccountSettings] = "account";
      }
    }

    return { values, sources };
  }

  /** Raw per-account overrides (layer 3), validated. Empty object = inherit all. */
  async getOverrides(accountId: string): Promise<AccountSettings> {
    const account = await this.prisma.socialAccount.findUnique({
      where: { id: accountId },
      select: { settings: true },
    });
    if (!account) throw new NotFoundException(`Account ${accountId} not found`);
    return AccountSettingsSchema.parse(account.settings ?? {});
  }

  /** Shallow-merge a patch into the account's overrides and persist it. */
  async updateOverrides(accountId: string, patch: AccountSettings): Promise<AccountSettings> {
    const validatedPatch = AccountSettingsSchema.parse(patch);
    const current = await this.getOverrides(accountId);
    const merged = AccountSettingsSchema.parse({ ...current, ...validatedPatch });

    await this.prisma.socialAccount.update({
      where: { id: accountId },
      data: { settings: merged },
    });
    this.logger.log(`Updated settings overrides for account ${accountId}`);
    return merged;
  }

  /** Replace ALL overrides with the given object (UI "reset to inherited"). */
  async replaceOverrides(accountId: string, next: AccountSettings): Promise<AccountSettings> {
    const merged = AccountSettingsSchema.parse(next);
    await this.prisma.socialAccount.update({
      where: { id: accountId },
      data: { settings: merged },
    });
    return merged;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Layer 2: globals derived from env (same values the services use today)
  // ─────────────────────────────────────────────────────────────────────────

  private envLayer(network: string): Partial<AccountSettings> {
    const get = (key: string): string | undefined =>
      this.configService.get<string>(key)?.toString();

    const firstLanguage = get("POSTING_LANGUAGES")?.split(",")[0]?.trim();
    const rateLimitDaily =
      get(`RATE_LIMIT_${network}_MAX_PER_DAY`) ?? get("RATE_LIMIT_X_MAX_PER_DAY");
    const rateLimitWeekly =
      get(`RATE_LIMIT_${network}_MAX_PER_WEEK`) ?? get("RATE_LIMIT_X_MAX_PER_WEEK");
    const minDelayMs = get("RATE_LIMIT_MIN_DELAY_MS");
    const autoApproveEnabled = get("AUTO_APPROVE_ENABLED");
    const autoApproveMinScoreRaw = get("AUTO_APPROVE_MIN_SCORE");

    return {
      ...(firstLanguage ? { postingLanguage: firstLanguage } : {}),
      ...(rateLimitDaily !== undefined && !Number.isNaN(Number(rateLimitDaily))
        ? { rateLimitDaily: Number(rateLimitDaily) }
        : {}),
      ...(rateLimitWeekly !== undefined && !Number.isNaN(Number(rateLimitWeekly))
        ? { rateLimitWeekly: Number(rateLimitWeekly) }
        : {}),
      ...(minDelayMs !== undefined && !Number.isNaN(Number(minDelayMs))
        ? { minDelayMs: Number(minDelayMs) }
        : {}),
      ...(autoApproveEnabled !== undefined
        ? { autoApproveEnabled: autoApproveEnabled === "true" }
        : {}),
      ...(autoApproveMinScoreRaw !== undefined && !Number.isNaN(Number(autoApproveMinScoreRaw))
        ? { autoApproveMinScore: Number(autoApproveMinScoreRaw) }
        : {}),
    };
  }
}
