import { flushPromises, mount } from "@vue/test-utils";
import { beforeEach, describe, expect, it, vi } from "vitest";
import PolicyRegistry from "../../src/views/PolicyRegistry.vue";

const api = { get: vi.fn(), post: vi.fn() };
const toast = { success: vi.fn(), error: vi.fn() };
vi.mock("../../src/composables/useApi", () => ({ useApi: () => api }));
vi.mock("../../src/composables/useToast", () => ({ useToast: () => toast }));

describe("PolicyRegistry view", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    api.get.mockImplementation((url: string) =>
      Promise.resolve({
        data: url.includes("evidence")
          ? [
              {
                id: "evidence-1",
                network: "X",
                sourceUrl: "https://x.com/rules",
                sourceType: "OFFICIAL",
                status: "DRAFT",
                expiresAt: null,
                versions: [],
              },
            ]
          : [
              {
                id: "policy-1",
                policyKey: "x.reply",
                version: 1,
                network: "X",
                action: "REPLY",
                transport: "BROWSER",
                executionMode: "HUMAN_APPROVAL_REQUIRED",
                status: "DRAFT",
                evidenceId: "evidence-1",
                expiresAt: null,
              },
            ],
      }),
    );
    api.post.mockResolvedValue({ data: {} });
  });

  it("shows evidence and policy version approval boundaries", async () => {
    const wrapper = mount(PolicyRegistry);
    await flushPromises();
    expect(wrapper.text()).toContain("Source evidence");
    expect(wrapper.text()).toContain("HUMAN_APPROVAL_REQUIRED");
    expect(wrapper.text()).toContain("Verify evidence");
  });

  it("verifies evidence through the policy registry endpoint", async () => {
    const wrapper = mount(PolicyRegistry);
    await flushPromises();
    const verify = wrapper.findAll("button").find((button) => button.text() === "Verify evidence");
    expect(verify).toBeDefined();
    await verify!.trigger("click");
    await flushPromises();
    expect(api.post).toHaveBeenCalledWith("/platform-policy/evidence/evidence-1/verify", {
      reviewer: "operator",
    });
  });
});
