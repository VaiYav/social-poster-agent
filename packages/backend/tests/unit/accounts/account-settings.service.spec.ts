/**
 * M1.2: AccountSettingsService — inheritance chain
 * defaults → env → account JSON, with provenance tracking.
 *
 * Source: packages/backend/src/modules/accounts/account-settings.service.ts
 */
import { describe, expect, it, vi } from "vitest";
import { NotFoundException } from "@nestjs/common";
import { AccountSettingsSchema } from "@spa/shared";
import { AccountSettingsService } from "../../../src/modules/accounts/account-settings.service.js";

function buildService(
  accountRow: Record<string, unknown> | null,
  env: Record<string, string> = {},
) {
  const configService = {
    get: vi.fn((key: string) => env[key]),
  } as unknown as import("@nestjs/config").ConfigService;
  const prisma = {
    socialAccount: {
      findUnique: vi.fn().mockResolvedValue(accountRow),
      update: vi.fn().mockResolvedValue({}),
    },
  } as unknown as import("../../../src/infrastructure/prisma/prisma.service.js").PrismaService;
  return {
    service: new AccountSettingsService(prisma, configService),
    prisma,
  };
}

const ACCOUNT_ID = "11111111-1111-4111-8111-111111111111";

describe("AccountSettingsService.resolve", () => {
  it("throws NotFound for a missing account", async () => {
    const { service } = buildService(null);
    await expect(service.resolve(ACCOUNT_ID)).rejects.toThrow(NotFoundException);
  });

  it("returns hard defaults when no env and no overrides", async () => {
    const { service } = buildService({
      id: ACCOUNT_ID,
      network: "X",
      active: true,
      settings: null,
    });
    const { values, sources } = await service.resolve(ACCOUNT_ID);
    expect(values.postingLanguage).toBe("en");
    expect(values.rateLimitDaily).toBe(1);
    expect(values.minDelayMs).toBe(300_000);
    expect(sources.postingLanguage).toBe("default");
  });

  it("resolves the persisted account active switch into the shared settings contract", async () => {
    const { service } = buildService({
      id: ACCOUNT_ID,
      network: "X",
      active: false,
      settings: null,
    });

    const { values, sources } = await service.resolve(ACCOUNT_ID);

    expect(values.active).toBe(false);
    expect(sources.active).toBe("account");
  });

  it("env layer overrides defaults", async () => {
    const { service } = buildService(
      { id: ACCOUNT_ID, network: "X", settings: null },
      {
        POSTING_LANGUAGES: "ru,en",
        RATE_LIMIT_X_MAX_PER_DAY: "3",
        AUTO_APPROVE_ENABLED: "true",
        AUTO_APPROVE_MIN_SCORE: "8",
      },
    );
    const { values, sources } = await service.resolve(ACCOUNT_ID);
    expect(values.postingLanguage).toBe("ru");
    expect(sources.postingLanguage).toBe("env");
    expect(values.rateLimitDaily).toBe(3);
    expect(values.autoApproveEnabled).toBe(true);
    expect(values.autoApproveMinScore).toBe(8);
  });

  it("account JSON overrides env; provenance reflects the winner", async () => {
    const { service } = buildService(
      {
        id: ACCOUNT_ID,
        network: "X",
        settings: { postingLanguage: "uk", brandVoice: "warm, witty", rateLimitDaily: 5 },
      },
      { POSTING_LANGUAGES: "en", RATE_LIMIT_X_MAX_PER_DAY: "3" },
    );
    const { values, sources } = await service.resolve(ACCOUNT_ID);
    expect(values.postingLanguage).toBe("uk");
    expect(sources.postingLanguage).toBe("account");
    expect(values.rateLimitDaily).toBe(5); // account beats env
    expect(values.brandVoice).toBe("warm, witty");
    expect(sources.rateLimitWeekly).toBe("default"); // untouched keys stay default
  });

  it("network-scoped env lookup falls back per network key", async () => {
    const { service } = buildService(
      { id: ACCOUNT_ID, network: "THREADS", settings: null },
      { RATE_LIMIT_X_MAX_PER_DAY: "2" }, // only X configured — fallback used
    );
    const { values } = await service.resolve(ACCOUNT_ID);
    expect(values.rateLimitDaily).toBe(2);
  });

  it("rejects invalid override shapes through Zod", () => {
    expect(() => AccountSettingsSchema.parse({ postingWindowHours: [25] })).toThrow();
    expect(() => AccountSettingsSchema.parse({ imageResolution: "8K" })).toThrow();
  });
});

describe("AccountSettingsService.updateOverrides", () => {
  it("shallow-merges patch over existing overrides and persists", async () => {
    const { service, prisma } = buildService({
      id: ACCOUNT_ID,
      network: "X",
      settings: { postingLanguage: "en" },
    });
    const result = await service.updateOverrides(ACCOUNT_ID, { rateLimitDaily: 4 });
    expect(result).toMatchObject({ postingLanguage: "en", rateLimitDaily: 4 });
    expect(prisma.socialAccount.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: ACCOUNT_ID },
        data: { settings: expect.objectContaining({ postingLanguage: "en", rateLimitDaily: 4 }) },
      }),
    );
  });

  it("updates the runtime account active column when the active override changes", async () => {
    const { service, prisma } = buildService({
      id: ACCOUNT_ID,
      network: "X",
      active: true,
      settings: {},
    });

    await service.updateOverrides(ACCOUNT_ID, { active: false });

    expect(prisma.socialAccount.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: ACCOUNT_ID },
        data: expect.objectContaining({ active: false }),
      }),
    );
  });
});
