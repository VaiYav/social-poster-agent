import { flushPromises, mount } from "@vue/test-utils";
import { describe, expect, it, vi, beforeEach } from "vitest";
import type { AccountSettings, ResolvedAccountSettings } from "@spa/shared";
import Accounts from "../../src/views/Accounts.vue";

const api = {
  get: vi.fn(),
  put: vi.fn(),
};

const toast = {
  success: vi.fn(),
  error: vi.fn(),
  warning: vi.fn(),
  info: vi.fn(),
};

vi.mock("../../src/composables/useApi", () => ({
  useApi: () => api,
}));

vi.mock("../../src/composables/useToast", () => ({
  useToast: () => toast,
}));

const values: Required<AccountSettings> = {
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

const resolved: ResolvedAccountSettings = {
  values,
  sources: Object.fromEntries(
    Object.keys(values).map((key) => [key, "default"]),
  ) as ResolvedAccountSettings["sources"],
};

describe("Accounts view", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    api.get.mockImplementation((url: string) => {
      if (url === "/accounts") {
        return Promise.resolve({
          data: [
            {
              id: "account-a",
              network: "THREADS",
              handle: "rhythm_a",
              displayName: "Rhythm A",
              priority: 1,
              active: true,
              warmupEnabled: false,
            },
          ],
        });
      }
      if (url.endsWith("/settings")) {
        return Promise.resolve({ data: resolved });
      }
      if (url.endsWith("/settings/overrides")) {
        return Promise.resolve({ data: { rateLimitDaily: 3 } });
      }
      throw new Error(`Unexpected GET ${url}`);
    });
    api.put.mockResolvedValue({ data: {} });
  });

  it("loads an account and shows resolved values with provenance", async () => {
    const wrapper = mount(Accounts);
    await flushPromises();

    expect(wrapper.text()).toContain("Rhythm A");
    expect(wrapper.text()).toContain("THREADS · @rhythm_a");
    expect(wrapper.find('input[name="rateLimitDaily"]').element).toHaveProperty("value", "3");
    expect(wrapper.text()).toContain("Account override");
  });

  it("submits only account overrides and keeps the mutation on PUT", async () => {
    const wrapper = mount(Accounts);
    await flushPromises();

    const dailyLimit = wrapper.find('input[name="rateLimitDaily"]');
    await dailyLimit.setValue("4");
    await wrapper.find("form").trigger("submit");
    await flushPromises();

    expect(api.put).toHaveBeenCalledWith("/accounts/account-a/settings", {
      rateLimitDaily: 4,
    });
    expect(toast.success).toHaveBeenCalledWith("Account settings saved");
  });
});
