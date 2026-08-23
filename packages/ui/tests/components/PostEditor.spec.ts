import { describe, expect, it } from "vitest";
import { mount } from "@vue/test-utils";
import PostEditor from "../../src/components/PostEditor.vue";

const post = {
  id: "post-1",
  network: "X",
  content: "Draft content",
} as never;

describe("PostEditor", () => {
  it("uses the Modal primitive and preserves save contract", async () => {
    const wrapper = mount(PostEditor, {
      props: { post },
      global: { stubs: { teleport: true } },
    });

    expect(wrapper.find('[role="dialog"]').exists()).toBe(true);
    await wrapper.find("textarea").setValue("Edited content");
    const saveButton = wrapper
      .findAll("button")
      .find((button) => button.text().includes("Save & Approve"));
    await saveButton!.trigger("click");

    expect(wrapper.emitted("save")).toEqual([["post-1", "Edited content"]]);
  });

  it("emits close through the shared modal dismiss control", async () => {
    const wrapper = mount(PostEditor, {
      props: { post },
      global: { stubs: { teleport: true } },
    });

    await wrapper.get('[data-testid="modal-close"]').trigger("click");

    expect(wrapper.emitted("close")).toHaveLength(1);
  });
});
