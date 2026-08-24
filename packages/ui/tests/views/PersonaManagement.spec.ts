import { flushPromises, mount } from "@vue/test-utils";
import { beforeEach, describe, expect, it, vi } from "vitest";
import PersonaManagement from "../../src/views/PersonaManagement.vue";

const api = { get: vi.fn(), put: vi.fn() };
const toast = { success: vi.fn(), error: vi.fn() };

vi.mock("../../src/composables/useApi", () => ({ useApi: () => api }));
vi.mock("../../src/composables/useToast", () => ({ useToast: () => toast }));

const persona = {
  id: "persona-1",
  key: "cosmic_analyst",
  displayName: "Cosmic Analyst",
  status: "DRAFT",
  revisions: [
    {
      id: "revision-1",
      version: 1,
      checksum: "abcdef123456",
      profile: {
        identity: {
          role: "Evidence-aware analyst",
          worldview: ["calibrated"],
          audienceJob: "Explain patterns",
          disclosure: "AI-assisted",
        },
        modes: [
          { id: "pattern_breakdown", purpose: "Explain patterns", allowedFirstPerson: false },
        ],
        contentPillars: [],
      },
    },
  ],
  assignments: [],
};

describe("PersonaManagement view", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    api.get.mockImplementation((url: string) =>
      Promise.resolve({
        data:
          url === "/personas"
            ? [persona]
            : [{ id: "account-1", network: "X", handle: "writer", displayName: "Writer" }],
      }),
    );
    api.put.mockResolvedValue({ data: {} });
  });

  it("shows immutable revision and disclosure context", async () => {
    const wrapper = mount(PersonaManagement);
    await flushPromises();

    expect(wrapper.text()).toContain("Cosmic Analyst");
    expect(wrapper.text()).toContain("AI-assisted");
    expect(wrapper.text()).toContain("v1");
  });

  it("assigns the selected persona revision and voice mode to an account", async () => {
    const wrapper = mount(PersonaManagement);
    await flushPromises();

    await wrapper.find("form").trigger("submit");
    await flushPromises();

    expect(api.put).toHaveBeenCalledWith("/personas/accounts/account-1/assignment", {
      personaId: "persona-1",
      personaRevisionId: "revision-1",
      defaultVoiceMode: "pattern_breakdown",
    });
  });
});
