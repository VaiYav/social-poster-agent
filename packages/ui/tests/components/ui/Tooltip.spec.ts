import { describe, it, expect } from "vitest";
import { mount } from "@vue/test-utils";
import Tooltip from "../../../src/components/ui/Tooltip.vue";

describe("Tooltip primitive", () => {
  it("renders trigger slot and tooltip text", () => {
    const wrapper = mount(Tooltip, {
      props: { text: "Helpful hint" },
      slots: { default: "<button>?</button>" },
    });
    expect(wrapper.find("button").exists()).toBe(true);
    expect(wrapper.find("[role=tooltip]").text()).toBe("Helpful hint");
  });

  it("defaults to top position", () => {
    const wrapper = mount(Tooltip, { props: { text: "t" } });
    expect(wrapper.find("[role=tooltip]").classes().join(" ")).toContain("bottom-full");
  });

  it("applies requested position", () => {
    const wrapper = mount(Tooltip, { props: { text: "t", position: "right" } });
    expect(wrapper.find("[role=tooltip]").classes().join(" ")).toContain("left-full");
  });
});
