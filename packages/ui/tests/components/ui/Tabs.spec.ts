import { describe, it, expect } from "vitest";
import { mount } from "@vue/test-utils";
import Tabs from "../../../src/components/ui/Tabs.vue";

const tabs = [
  { value: "drafts", label: "Drafts", count: 3 },
  { value: "queue", label: "Queue" },
];

describe("Tabs primitive", () => {
  it("renders all tabs with labels and counts", () => {
    const wrapper = mount(Tabs, { props: { tabs, modelValue: "drafts" } });
    expect(wrapper.find('[data-testid="tab-drafts"]').text()).toContain("Drafts");
    expect(wrapper.find('[data-testid="tab-drafts"]').text()).toContain("3");
    expect(wrapper.find('[data-testid="tab-queue"]').exists()).toBe(true);
  });

  it("marks the active tab via aria-selected", () => {
    const wrapper = mount(Tabs, { props: { tabs, modelValue: "queue" } });
    expect(wrapper.find('[data-testid="tab-queue"]').attributes("aria-selected")).toBe("true");
    expect(wrapper.find('[data-testid="tab-drafts"]').attributes("aria-selected")).toBe("false");
  });

  it("emits update:modelValue on click", async () => {
    const wrapper = mount(Tabs, { props: { tabs, modelValue: "drafts" } });
    await wrapper.find('[data-testid="tab-queue"]').trigger("click");
    expect(wrapper.emitted("update:modelValue")?.[0]).toEqual(["queue"]);
  });

  it("does not emit when clicking the active tab", async () => {
    const wrapper = mount(Tabs, { props: { tabs, modelValue: "drafts" } });
    await wrapper.find('[data-testid="tab-drafts"]').trigger("click");
    expect(wrapper.emitted("update:modelValue")).toBeUndefined();
  });
});
