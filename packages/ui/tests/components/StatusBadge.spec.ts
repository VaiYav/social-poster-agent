import { describe, it, expect } from "vitest";
import { mount } from "@vue/test-utils";
import StatusBadge from "../../src/components/StatusBadge.vue";

describe("StatusBadge component", () => {
  it("renders the status text", () => {
    const wrapper = mount(StatusBadge, { props: { status: "DRAFT" } });
    expect(wrapper.text()).toBe("DRAFT");
  });

  it("applies neutral variant for DRAFT", () => {
    const wrapper = mount(StatusBadge, { props: { status: "DRAFT" } });
    expect(wrapper.find("span").classes()).toContain("bg-surface-highlight");
  });

  it("applies success variant for POSTED", () => {
    const wrapper = mount(StatusBadge, { props: { status: "POSTED" } });
    expect(wrapper.find("span").classes()).toContain("bg-success-subtle");
    expect(wrapper.find("span").classes()).toContain("text-success");
  });

  it("applies error variant for FAILED", () => {
    const wrapper = mount(StatusBadge, { props: { status: "FAILED" } });
    expect(wrapper.find("span").classes()).toContain("bg-error-subtle");
    expect(wrapper.find("span").classes()).toContain("text-error");
  });

  it("falls back to neutral for unknown status", () => {
    const wrapper = mount(StatusBadge, { props: { status: "UNKNOWN" } });
    expect(wrapper.find("span").classes()).toContain("bg-surface-highlight");
  });
});
