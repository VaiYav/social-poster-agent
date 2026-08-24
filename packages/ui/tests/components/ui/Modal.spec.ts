import { describe, it, expect } from "vitest";
import { mount } from "@vue/test-utils";
import Modal from "../../../src/components/ui/Modal.vue";

function mountModal(props: Record<string, unknown>, slots: Record<string, string> = {}) {
  return mount(Modal, {
    props,
    slots,
    // jsdom does not implement Teleport targets; render inline instead.
    global: { stubs: { teleport: true } },
  });
}

describe("Modal primitive", () => {
  it("renders nothing when closed", () => {
    const wrapper = mountModal({ open: false, title: "T" });
    expect(wrapper.find('[role="dialog"]').exists()).toBe(false);
  });

  it("renders title and content when open", () => {
    const wrapper = mountModal({ open: true, title: "Confirm" }, { default: "<p>Body text</p>" });
    expect(wrapper.find("[role=dialog]").exists()).toBe(true);
    expect(wrapper.text()).toContain("Confirm");
    expect(wrapper.text()).toContain("Body text");
  });

  it("emits update:open + close on X button", async () => {
    const wrapper = mountModal({ open: true, title: "T" });
    await wrapper.find('[data-testid="modal-close"]').trigger("click");
    expect(wrapper.emitted("update:open")?.[0]).toEqual([false]);
    expect(wrapper.emitted("close")).toHaveLength(1);
  });

  it("emits close on backdrop click when closeOnBackdrop", async () => {
    const wrapper = mountModal({ open: true, title: "T", closeOnBackdrop: true });
    await wrapper.find('[data-testid="modal-backdrop"]').trigger("click");
    expect(wrapper.emitted("close")).toHaveLength(1);
  });

  it("ignores backdrop click when closeOnBackdrop=false", async () => {
    const wrapper = mountModal({ open: true, title: "T", closeOnBackdrop: false });
    await wrapper.find('[data-testid="modal-backdrop"]').trigger("click");
    expect(wrapper.emitted("close")).toBeUndefined();
  });

  it("applies size classes", () => {
    const wrapper = mountModal({ open: true, title: "T", size: "lg" });
    expect(wrapper.find("[role=dialog]").classes().join(" ")).toContain("max-w-2xl");
  });

  it("renders footer slot", () => {
    const wrapper = mountModal({ open: true, title: "T" }, { footer: "<button>Save</button>" });
    expect(wrapper.text()).toContain("Save");
  });

  it("closes on Escape keydown while open", async () => {
    const wrapper = mountModal({ open: true, title: "T" });
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    await wrapper.vm.$nextTick();
    expect(wrapper.emitted("close")).toHaveLength(1);
  });
});
