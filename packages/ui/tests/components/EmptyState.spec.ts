import { describe, it, expect } from "vitest";
import { mount } from "@vue/test-utils";
import EmptyState from "../../src/components/EmptyState.vue";

describe("EmptyState component", () => {
  it("renders default message", () => {
    const wrapper = mount(EmptyState);
    expect(wrapper.text()).toContain("No data found.");
  });

  it("renders custom message", () => {
    const wrapper = mount(EmptyState, { props: { message: "No posts yet." } });
    expect(wrapper.text()).toContain("No posts yet.");
  });
});
