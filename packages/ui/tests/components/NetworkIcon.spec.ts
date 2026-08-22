import { describe, it, expect } from "vitest";
import { mount } from "@vue/test-utils";
import NetworkIcon from "../../src/components/NetworkIcon.vue";

describe("NetworkIcon component", () => {
  it("renders X icon and label", () => {
    const wrapper = mount(NetworkIcon, { props: { network: "X" } });
    expect(wrapper.text()).toContain("𝕏");
    expect(wrapper.text()).toContain("X.com");
  });

  it("renders THREADS icon and label", () => {
    const wrapper = mount(NetworkIcon, { props: { network: "THREADS" } });
    expect(wrapper.text()).toContain("🧵");
    expect(wrapper.text()).toContain("Threads");
  });

  it("renders FACEBOOK icon and label", () => {
    const wrapper = mount(NetworkIcon, { props: { network: "FACEBOOK" } });
    expect(wrapper.text()).toContain("📘");
    expect(wrapper.text()).toContain("Facebook");
  });

  it("falls back to ? and raw network name for unknown", () => {
    const wrapper = mount(NetworkIcon, { props: { network: "MASTODON" } });
    expect(wrapper.text()).toContain("?");
    expect(wrapper.text()).toContain("MASTODON");
  });
});
