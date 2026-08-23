import { flushPromises, mount } from "@vue/test-utils";
import { beforeEach, describe, expect, it, vi } from "vitest";
import CreatorRelationships from "../../src/views/CreatorRelationships.vue";

const api = { get: vi.fn(), post: vi.fn() };
const toast = { success: vi.fn(), error: vi.fn() };

vi.mock("../../src/composables/useApi", () => ({ useApi: () => api }));
vi.mock("../../src/composables/useToast", () => ({ useToast: () => toast }));

const relationship = {
  id: "relationship-1",
  stage: "RECIPROCAL",
  status: "ACTIVE",
  interactionCount: 4,
  substantiveReplyCount: 2,
  reciprocalCount: 1,
  cooldownUntil: null,
  ownerNote: null,
  version: 1,
  creator: {
    id: "creator-1",
    network: "X",
    handleCanonical: "publicwriter",
    displayName: "Public Writer",
    profileUrl: "https://x.com/publicwriter",
    status: "ACTIVE",
    publicTopics: ["writing"],
  },
  evidence: [
    {
      id: "evidence-1",
      evidenceType: "PUBLIC_REPLY",
      occurredAt: "2026-08-23T10:00:00Z",
      weight: 1,
    },
  ],
};

describe("CreatorRelationships view", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    api.get.mockImplementation((url: string) =>
      Promise.resolve({ data: url.includes("identity-links") ? [] : [relationship] }),
    );
    api.post.mockResolvedValue({ data: {} });
  });

  it("shows the public relationship signal and operator safety controls", async () => {
    const wrapper = mount(CreatorRelationships);
    await flushPromises();

    expect(wrapper.text()).toContain("Public Writer");
    expect(wrapper.text()).toContain("RECIPROCAL");
    expect(wrapper.text()).toContain("Do not engage");
    expect(wrapper.text()).toContain("Recommendations never send outreach automatically");
    expect(wrapper.text()).toContain("Evidence timeline");
  });

  it("sets a manual cooldown through the CRM endpoint", async () => {
    const wrapper = mount(CreatorRelationships);
    await flushPromises();

    const cooldownButton = wrapper
      .findAll("button")
      .find((button) => button.text().includes("Set 24-hour cooldown"));
    expect(cooldownButton).toBeDefined();
    await cooldownButton!.trigger("click");
    await flushPromises();

    expect(api.post).toHaveBeenCalledWith(
      "/creators/relationships/relationship-1/cooldown",
      expect.objectContaining({ reason: expect.stringContaining("repetitive targeting") }),
    );
    expect(toast.success).toHaveBeenCalledWith("24-hour cooldown set");
  });
});
