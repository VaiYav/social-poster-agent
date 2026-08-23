import { flushPromises, mount } from "@vue/test-utils";
import { beforeEach, describe, expect, it, vi } from "vitest";
import EngagementSuggestions from "../../src/views/EngagementSuggestions.vue";

const api = { get: vi.fn(), post: vi.fn() };
const toast = { success: vi.fn(), error: vi.fn() };

vi.mock("../../src/composables/useApi", () => ({ useApi: () => api }));
vi.mock("../../src/composables/useToast", () => ({ useToast: () => toast }));

const suggestion = {
  id: "suggestion-1",
  accountId: "account-1",
  network: "THREADS",
  targetUrl: "https://threads.net/@writer/post/1",
  sourceSnapshotHash: "snapshot-1",
  voiceMode: "gentle_reflection",
  intent: "ASK_SPECIFIC_QUESTION",
  content: "What helped you notice that pattern earlier?",
  policyMode: "HUMAN_APPROVAL_REQUIRED",
  status: "PROPOSED",
  version: 2,
  expiresAt: "2026-08-24T10:00:00Z",
  createdAt: "2026-08-23T10:00:00Z",
};

describe("EngagementSuggestions view", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    api.get.mockResolvedValue({ data: [suggestion] });
    api.post.mockResolvedValue({ data: {} });
  });

  it("shows a pending suggestion and explicit non-execution copy", async () => {
    const wrapper = mount(EngagementSuggestions);
    await flushPromises();

    expect(wrapper.text()).toContain("What helped you notice that pattern earlier?");
    expect(wrapper.text()).toContain("HUMAN_APPROVAL_REQUIRED");
    expect(wrapper.text()).toContain("never sends a network action itself");
  });

  it("approves with the current optimistic-concurrency version", async () => {
    const wrapper = mount(EngagementSuggestions);
    await flushPromises();

    const approve = wrapper.findAll("button").find((button) => button.text() === "Approve");
    expect(approve).toBeDefined();
    await approve!.trigger("click");
    await flushPromises();

    expect(api.post).toHaveBeenCalledWith("/engagement/suggestions/suggestion-1/approve", {
      reviewerId: "operator",
      expectedVersion: 2,
    });
  });
});
