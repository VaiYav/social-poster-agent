import { describe, it, expect } from "vitest";
import { mount } from "@vue/test-utils";
import LoadingSpinner from "../../src/components/LoadingSpinner.vue";

describe("LoadingSpinner component", () => {
  it("renders default message", () => {
    const wrapper = mount(LoadingSpinner);
    expect(wrapper.text()).toContain("Loading...");
  });

  it("renders custom message", () => {
    const wrapper = mount(LoadingSpinner, { props: { message: "Fetching posts..." } });
    expect(wrapper.text()).toContain("Fetching posts...");
  });

  it("contains an animated svg spinner", () => {
    const wrapper = mount(LoadingSpinner);
    expect(wrapper.find("svg.animate-spin").exists()).toBe(true);
  });
});
