import { describe, it, expect } from "vitest";
import { mount } from "@vue/test-utils";
import Table from "../../../src/components/ui/Table.vue";

describe("Table primitive", () => {
  function mountTable(
    props = {},
    content = "<thead><tr><th>Col</th></tr></thead><tbody><tr><td>A</td></tr></tbody>",
  ) {
    return mount(Table, { props, slots: { default: content } });
  }

  it("renders slotted table markup", () => {
    const wrapper = mountTable();
    expect(wrapper.find("table").exists()).toBe(true);
    expect(wrapper.find("th").text()).toBe("Col");
    expect(wrapper.find("td").text()).toBe("A");
  });

  it("shows empty state instead of table rows when empty", () => {
    const wrapper = mountTable({ empty: true, emptyText: "No posts" }, "");
    expect(wrapper.find('[data-testid="table-empty"]').text()).toBe("No posts");
  });

  it("hides empty state when not empty", () => {
    const wrapper = mountTable();
    expect(wrapper.find('[data-testid="table-empty"]').exists()).toBe(false);
  });

  it("shows loading state and hides empty while loading", () => {
    const wrapper = mountTable({ loading: true, empty: true });
    expect(wrapper.find('[data-testid="table-loading"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="table-empty"]').exists()).toBe(false);
  });

  it("applies hoverable class by default", () => {
    const wrapper = mountTable();
    expect(wrapper.find("table").classes()).toContain("hoverable");
  });

  it("drops hoverable class when hoverable=false", () => {
    const wrapper = mountTable({ hoverable: false });
    expect(wrapper.find("table").classes()).not.toContain("hoverable");
  });
});
