import { flushPromises, mount } from "@vue/test-utils";
import { beforeEach, describe, expect, it, vi } from "vitest";
import GroundingReview from "../../src/views/GroundingReview.vue";

const api = { get: vi.fn(), post: vi.fn() };
const toast = { success: vi.fn(), error: vi.fn() };

vi.mock("../../src/composables/useApi", () => ({ useApi: () => api }));
vi.mock("../../src/composables/useToast", () => ({ useToast: () => toast }));

describe("GroundingReview view", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    api.get.mockImplementation((url: string) =>
      Promise.resolve({
        data: url.includes("memories")
          ? [
              {
                id: "memory-1",
                personaId: "persona-1",
                kind: "STANCE",
                text: "A candidate stance",
                sourceType: "OPERATOR",
                status: "CANDIDATE",
                confidence: 0.8,
              },
            ]
          : [
              {
                id: "evidence-1",
                domain: "astrology",
                riskClass: "LOW",
                title: "Verified source",
                text: "Evidence text",
                sourceType: "PAPER",
                reviewStatus: "NEEDS_REVIEW",
              },
            ],
      }),
    );
    api.post.mockResolvedValue({ data: {} });
  });

  it("shows separate evidence and memory review queues", async () => {
    const wrapper = mount(GroundingReview);
    await flushPromises();

    expect(wrapper.text()).toContain("Knowledge evidence");
    expect(wrapper.text()).toContain("Memory candidates");
    expect(wrapper.text()).toContain("A candidate stance");
  });

  it("verifies evidence through the admin review endpoint", async () => {
    const wrapper = mount(GroundingReview);
    await flushPromises();

    const verify = wrapper.findAll("button").find((button) => button.text() === "Verify");
    expect(verify).toBeDefined();
    await verify!.trigger("click");
    await flushPromises();

    expect(api.post).toHaveBeenCalledWith("/grounding/evidence/evidence-1/review", {
      reviewStatus: "VERIFIED",
      reviewer: "operator",
    });
  });
});
