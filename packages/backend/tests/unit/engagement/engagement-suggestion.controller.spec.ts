import { describe, expect, it, vi } from "vitest";
import { EngagementSuggestionController } from "../../../src/modules/engagement/engagement-suggestion.controller.js";

function buildController() {
  const suggestions = {
    list: vi.fn().mockResolvedValue([]),
    findById: vi.fn().mockResolvedValue({ id: "s1" }),
    review: vi.fn().mockResolvedValue({ id: "s1", status: "APPROVED" }),
    expire: vi.fn().mockResolvedValue({ id: "s1", status: "EXPIRED" }),
  };
  return { controller: new EngagementSuggestionController(suggestions as never), suggestions };
}

const review = { reviewerId: "operator", expectedVersion: 1 };

describe("EngagementSuggestionController", () => {
  it("validates list filters and delegates reads", async () => {
    const { controller, suggestions } = buildController();

    await expect(controller.list("acc-1", "X", "PROPOSED")).resolves.toEqual([]);
    expect(() => controller.list(undefined, "NOPE")).toThrow("Unsupported social network");
    await expect(controller.find("s1")).resolves.toEqual({ id: "s1" });
    expect(suggestions.list).toHaveBeenCalledWith({
      accountId: "acc-1",
      network: "X",
      status: "PROPOSED",
    });
  });

  it("delegates approve, edit, reject, and expire decisions", async () => {
    const { controller, suggestions } = buildController();

    await expect(controller.approve("s1", review)).resolves.toEqual({
      id: "s1",
      status: "APPROVED",
    });
    await expect(
      controller.editAndApprove("s1", { ...review, content: "edited" }),
    ).resolves.toEqual({
      id: "s1",
      status: "APPROVED",
    });
    await expect(controller.reject("s1", review)).resolves.toEqual({
      id: "s1",
      status: "APPROVED",
    });
    await expect(controller.expire("s1")).resolves.toEqual({ id: "s1", status: "EXPIRED" });
    expect(suggestions.review).toHaveBeenNthCalledWith(1, "s1", {
      ...review,
      decision: "APPROVED",
    });
    expect(suggestions.review).toHaveBeenNthCalledWith(2, "s1", {
      ...review,
      content: "edited",
      decision: "EDITED",
    });
    expect(suggestions.review).toHaveBeenNthCalledWith(3, "s1", {
      ...review,
      decision: "REJECTED",
    });
  });

  it("rejects malformed review payloads and empty edits", async () => {
    const { controller } = buildController();

    await expect(controller.approve("s1", {})).rejects.toThrow();
    await expect(controller.editAndApprove("s1", { ...review, content: "" })).rejects.toThrow();
    await expect(
      controller.reject("s1", { reviewerId: "operator", expectedVersion: 0 }),
    ).rejects.toThrow();
  });
});
