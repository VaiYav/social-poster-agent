import { flushPromises, mount } from "@vue/test-utils";
import { beforeEach, describe, expect, it, vi } from "vitest";
import DemandRadar from "../../src/views/DemandRadar.vue";

const api = { get: vi.fn(), post: vi.fn() };
const toast = { success: vi.fn(), error: vi.fn() };

vi.mock("../../src/composables/useApi", () => ({ useApi: () => api }));
vi.mock("../../src/composables/useToast", () => ({ useToast: () => toast }));

const cluster = {
  id: "cluster-1",
  label: "how to pace a new routine",
  canonicalQuestion: "how to pace a new routine",
  domain: "wellness",
  riskTier: "LOW",
  status: "REVIEWED",
  demandScore: 0.8,
  sourceCount: 4,
  distinctAuthorCount: 3,
  firstSeenAt: "2026-08-23T10:00:00Z",
  lastSeenAt: "2026-08-23T11:00:00Z",
};

describe("DemandRadar view", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    api.get.mockResolvedValue({ data: [cluster] });
    api.post.mockResolvedValue({ data: {} });
  });

  it("shows a reviewed public cluster and privacy boundary", async () => {
    const wrapper = mount(DemandRadar);
    await flushPromises();

    expect(wrapper.text()).toContain("how to pace a new routine");
    expect(wrapper.text()).toContain("REVIEWED");
    expect(wrapper.text()).toContain("aggregate-only");
  });

  it("validates a reviewed cluster through the operator endpoint", async () => {
    const wrapper = mount(DemandRadar);
    await flushPromises();

    const validate = wrapper
      .findAll("button")
      .find((button) => button.text() === "Validate cluster");
    expect(validate).toBeDefined();
    await validate!.trigger("click");
    await flushPromises();

    expect(api.post).toHaveBeenCalledWith("/demand/clusters/cluster-1/review", {
      status: "VALIDATED",
      reviewer: "operator",
    });
  });
});
