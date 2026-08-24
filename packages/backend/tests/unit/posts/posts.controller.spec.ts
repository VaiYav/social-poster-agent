/**
 * MOD-02: HITL Post Management Module — PostsController unit tests.
 *
 * Traces to: REQ-009..015
 * Hazards: HAZ-003, HAZ-004
 *
 * Source: packages/backend/src/modules/posts/posts.controller.ts
 * Spec:   CONSTITUTION.md §14 (Testing) — test case IDs are inline (MOD-02 controller coverage)
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NotFoundException } from "@nestjs/common";
import { ModuleRef } from "@nestjs/core";
import { PostsController } from "../../../src/modules/posts/posts.controller.js";
import { PostsService } from "../../../src/modules/posts/posts.service.js";
import { createMockConfigService, fixturePost } from "../../mocks/index.js";

describe("MOD-02: PostsController", () => {
  let controller: PostsController;
  let postsService: {
    findMany: ReturnType<typeof vi.fn>;
    findById: ReturnType<typeof vi.fn>;
    findDrafts: ReturnType<typeof vi.fn>;
    create: ReturnType<typeof vi.fn>;
    updateStatus: ReturnType<typeof vi.fn>;
    approve: ReturnType<typeof vi.fn>;
    reject: ReturnType<typeof vi.fn>;
  };
  let moduleRef: { get: ReturnType<typeof vi.fn> };
  let queueService: { enqueuePosting: ReturnType<typeof vi.fn> };
  let postingWindowService: {
    getRecommendation: ReturnType<typeof vi.fn>;
    getDelayToNextWindow: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    postsService = {
      findMany: vi.fn(),
      findById: vi.fn(),
      findDrafts: vi.fn(),
      create: vi.fn(),
      updateStatus: vi.fn(),
      approve: vi.fn(),
      reject: vi.fn(),
    };
    queueService = {
      enqueuePosting: vi.fn().mockResolvedValue(undefined),
    };
    postingWindowService = {
      getRecommendation: vi.fn().mockResolvedValue({
        bestHours: [9, 12, 18, 21],
        inWindow: true,
        confidence: "low",
      }),
      getDelayToNextWindow: vi.fn().mockResolvedValue(0),
    };
    moduleRef = {
      get: vi.fn().mockReturnValue(queueService),
    };
    controller = new PostsController(
      postsService as unknown as PostsService,
      // A5: PostsController now injects IPostingQueuePort directly (no ModuleRef).
      queueService as never,
      postingWindowService as never,
      createMockConfigService(),
    );
  });

  // ── GET / (findMany) ────────────────────────────────────────

  it("UTC-C-026: findMany() parses query and delegates to service", async () => {
    const expected = { posts: [fixturePost], total: 1, limit: 20, offset: 0 };
    postsService.findMany.mockResolvedValue(expected);

    const result = await controller.findMany({
      status: "DRAFT",
      network: "X",
      limit: 20,
      offset: 0,
    });

    expect(result).toBe(expected);
    const arg = postsService.findMany.mock.calls[0][0];
    expect(arg.status).toBe("DRAFT");
    expect(arg.network).toBe("X");
    expect(arg.limit).toBe(20);
    expect(arg.offset).toBe(0);
  });

  it("UTC-C-026b: findMany() applies default limit/offset when omitted", async () => {
    const expected = { posts: [], total: 0, limit: 50, offset: 0 };
    postsService.findMany.mockResolvedValue(expected);

    await controller.findMany({});

    const arg = postsService.findMany.mock.calls[0][0];
    expect(arg.limit).toBe(50);
    expect(arg.offset).toBe(0);
  });

  // ── GET /drafts (findDrafts) ────────────────────────────────

  it("UTC-C-032: findDrafts() passes network filter to service", async () => {
    const drafts = [{ ...fixturePost, id: "d1" }];
    postsService.findDrafts.mockResolvedValue(drafts);

    const result = await controller.findDrafts("X");

    expect(result).toBe(drafts);
    expect(postsService.findDrafts).toHaveBeenCalledWith("X");
  });

  it("UTC-C-033: findDrafts() calls service with undefined when no network", async () => {
    postsService.findDrafts.mockResolvedValue([]);

    await controller.findDrafts();

    expect(postsService.findDrafts).toHaveBeenCalledWith(undefined);
  });

  // ── GET /:id (findById) ─────────────────────────────────────

  it("UTC-C-030: findById() delegates to service and returns post", async () => {
    const post = { ...fixturePost, id: "post-123" };
    postsService.findById.mockResolvedValue(post);

    const result = await controller.findById("post-123");

    expect(result).toBe(post);
    expect(postsService.findById).toHaveBeenCalledWith("post-123");
  });

  it("UTC-C-031: findById() propagates NotFoundException from service", async () => {
    postsService.findById.mockRejectedValue(new NotFoundException("Post missing not found"));

    await expect(controller.findById("missing")).rejects.toThrow(NotFoundException);
  });

  // ── POST / (create) ─────────────────────────────────────────

  it("UTC-C-034: create() parses body and persists post", async () => {
    const created = { id: "new-post" };
    postsService.create.mockResolvedValue(created);

    const result = await controller.create({
      accountId: "11111111-1111-1111-1111-111111111111",
      network: "X",
      content: "hello world",
    });

    expect(result).toBe(created);
    const arg = postsService.create.mock.calls[0][0];
    expect(arg.accountId).toBe("11111111-1111-1111-1111-111111111111");
    expect(arg.network).toBe("X");
    expect(arg.content).toBe("hello world");
  });

  // ── PATCH /:id/status (updateStatus) ────────────────────────

  it("UTC-C-035: updateStatus() delegates APPROVED transition to service", async () => {
    const updated = { ...fixturePost, status: "APPROVED" };
    postsService.updateStatus.mockResolvedValue(updated);

    const result = await controller.updateStatus("post-1", { status: "APPROVED" });

    expect(result).toBe(updated);
    expect(postsService.updateStatus).toHaveBeenCalledWith("post-1", {
      status: "APPROVED",
    });
  });

  it("UTC-C-036: updateStatus() delegates POSTED transition with postUrl", async () => {
    postsService.updateStatus.mockResolvedValue({ status: "POSTED" });

    await controller.updateStatus("post-1", {
      status: "POSTED",
      postUrl: "https://x.com/123",
    });

    expect(postsService.updateStatus).toHaveBeenCalledWith("post-1", {
      status: "POSTED",
      postUrl: "https://x.com/123",
    });
  });

  it("UTC-C-037: updateStatus() delegates FAILED transition with errorMessage", async () => {
    postsService.updateStatus.mockResolvedValue({ status: "FAILED" });

    await controller.updateStatus("post-1", {
      status: "FAILED",
      errorMessage: "timeout",
    });

    expect(postsService.updateStatus).toHaveBeenCalledWith("post-1", {
      status: "FAILED",
      errorMessage: "timeout",
    });
  });

  it("UTC-C-038: updateStatus() rethrows NotFoundException when service throws", async () => {
    postsService.updateStatus.mockRejectedValue(new NotFoundException("nope"));

    await expect(controller.updateStatus("nonexistent", { status: "APPROVED" })).rejects.toThrow(
      NotFoundException,
    );
  });

  // ── POST /:id/approve ───────────────────────────────────────

  it("UTC-C-035b: approve() calls postsService.approve with id (D2: no editedContent)", async () => {
    postsService.approve.mockResolvedValue({
      ...fixturePost,
      id: "post-1",
      status: "APPROVED",
      network: "X",
    });

    await controller.approve("post-1", {});

    expect(postsService.approve).toHaveBeenCalledWith("post-1", undefined);
  });

  it("UTC-C-035b2: approve() passes editedContent to service (D2)", async () => {
    postsService.approve.mockResolvedValue({
      ...fixturePost,
      id: "post-1",
      status: "APPROVED",
      network: "X",
      content: "edited",
    });

    await controller.approve("post-1", { editedContent: "edited text" });

    expect(postsService.approve).toHaveBeenCalledWith("post-1", "edited text");
  });

  it("P0-fix: approve() enqueues to BullMQ posting queue after approval", async () => {
    const approvedPost = { ...fixturePost, id: "post-1", status: "APPROVED", network: "X" };
    postsService.approve.mockResolvedValue(approvedPost);

    await controller.approve("post-1", {});

    expect(queueService.enqueuePosting).toHaveBeenCalledWith("post-1", "X", undefined, "acc-001");
  });

  it("P0-fix: approve() does NOT enqueue if service throws", async () => {
    postsService.approve.mockRejectedValue(new Error("not found"));

    await expect(controller.approve("missing", {})).rejects.toThrow(NotFoundException);
    expect(queueService.enqueuePosting).not.toHaveBeenCalled();
  });

  it("P0-fix/A5: approve() swallows enqueue failures and still approves", async () => {
    const approvedPost = { ...fixturePost, id: "post-1", status: "APPROVED", network: "X" };
    postsService.approve.mockResolvedValue(approvedPost);
    queueService.enqueuePosting.mockRejectedValue(new Error("queue down")); // port throws

    const result = await controller.approve("post-1", {}); // should not throw

    expect(result).toBe(approvedPost);
    expect(queueService.enqueuePosting).toHaveBeenCalledWith("post-1", "X", undefined, "acc-001");
  });

  it("UTC-C-035c: approve() throws NotFoundException when service throws", async () => {
    postsService.approve.mockRejectedValue(new Error("not found"));

    await expect(controller.approve("missing", {})).rejects.toThrow(NotFoundException);
  });

  // ── POST /:id/reject ────────────────────────────────────────

  it("UTC-C-reject: reject() delegates to postsService.reject", async () => {
    postsService.reject.mockResolvedValue({ status: "REJECTED" });

    await controller.reject("post-1");

    expect(postsService.reject).toHaveBeenCalledWith("post-1");
  });

  it("UTC-C-reject-404: reject() throws NotFoundException when service throws", async () => {
    postsService.reject.mockRejectedValue(new Error("not found"));

    await expect(controller.reject("missing")).rejects.toThrow(NotFoundException);
  });
});
