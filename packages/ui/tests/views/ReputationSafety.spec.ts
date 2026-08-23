import { flushPromises, mount } from "@vue/test-utils";
import { beforeEach, describe, expect, it, vi } from "vitest";
import ReputationSafety from "../../src/views/ReputationSafety.vue";

const api = { get: vi.fn(), post: vi.fn() };
const toast = { success: vi.fn(), error: vi.fn() };
vi.mock("../../src/composables/useApi", () => ({ useApi: () => api }));
vi.mock("../../src/composables/useToast", () => ({ useToast: () => toast }));

describe("ReputationSafety view", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    api.get.mockImplementation((url: string) => {
      if (url === "/accounts")
        return Promise.resolve({
          data: [{ id: "account-1", network: "X", handle: "writer", displayName: "Writer" }],
        });
      if (url.startsWith("/reputation/accounts"))
        return Promise.resolve({
          data: { state: "PAUSED", record: { version: 3, reason: "Operator review" } },
        });
      return Promise.resolve({
        data: [
          {
            id: "incident-1",
            severity: "CRITICAL",
            stateBefore: "LIMITED",
            stateAfter: "PAUSED",
            status: "OPEN",
            createdAt: "2026-08-23T10:00:00Z",
            owner: null,
          },
        ],
      });
    });
    api.post.mockResolvedValue({ data: {} });
  });

  it("shows scoped reputation state and incident controls", async () => {
    const wrapper = mount(ReputationSafety);
    await flushPromises();
    expect(wrapper.text()).toContain("PAUSED");
    expect(wrapper.text()).toContain("Posting and engagement are paused");
    expect(wrapper.text()).toContain("Acknowledge");
  });

  it("submits staged recovery with optimistic version", async () => {
    const wrapper = mount(ReputationSafety);
    await flushPromises();
    await wrapper.find("form").find("input").setValue("Reviewed incident and controls");
    await wrapper.find("form").trigger("submit");
    await flushPromises();
    expect(api.post).toHaveBeenCalledWith(
      "/reputation/accounts/account-1/recover",
      expect.objectContaining({ expectedVersion: 3, reviewer: "operator" }),
    );
  });
});
