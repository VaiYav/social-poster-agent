import { beforeEach, describe, expect, it, vi } from "vitest";
import { mount } from "@vue/test-utils";
import ReviewFeedbackDialog from "../../src/components/ReviewFeedbackDialog.vue";
import type { Post } from "@spa/shared";

function makePost(): Post {
  return {
    id: "post-1",
    generationRunId: null,
    accountId: "acc-1",
    threadId: null,
    threadPosition: 0,
    network: "X",
    content: "Draft content",
    sourceRef: null,
    status: "DRAFT",
    postUrl: null,
    errorMessage: null,
    retryCount: 0,
    llmMetadata: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    approvedAt: null,
    postedAt: null,
  };
}

describe("ReviewFeedbackDialog", () => {
  beforeEach(() => {
    HTMLDialogElement.prototype.showModal = vi.fn(function (this: HTMLDialogElement) {
      Object.defineProperty(this, "open", { value: true, configurable: true });
    });
    HTMLDialogElement.prototype.close = vi.fn(function (this: HTMLDialogElement) {
      Object.defineProperty(this, "open", { value: false, configurable: true });
    });
  });

  it("requires a reason before submitting", async () => {
    const wrapper = mount(ReviewFeedbackDialog, { props: { post: makePost() } });
    await wrapper.find("form").trigger("submit");
    expect(wrapper.text()).toContain("Choose at least one review reason.");
    expect(wrapper.emitted("submit")).toBeUndefined();
  });

  it("emits selected reason codes and an optional note", async () => {
    const wrapper = mount(ReviewFeedbackDialog, { props: { post: makePost() } });
    await wrapper.find('input[type="checkbox"]').setValue(true);
    await wrapper.find("textarea").setValue("Needs a source");
    await wrapper.find("form").trigger("submit");

    expect(wrapper.emitted("submit")).toEqual([
      [{ reasonCodes: ["FACT_UNSUPPORTED"], comment: "Needs a source" }],
    ]);
  });
});
