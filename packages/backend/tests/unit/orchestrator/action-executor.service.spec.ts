import { describe, expect, it, vi } from "vitest";
import { ActionExecutorService } from "../../../src/modules/orchestrator/action-executor.service.js";
import type { Action } from "../../../src/modules/orchestrator/types.js";
import { SocialNetwork } from "../../../src/generated/prisma/client.js";

const ACTION_TYPES = [
  "GENERATE_TOPICS",
  "GENERATE_POSTS",
  "POST",
  "BROWSE",
  "RECOVER_SESSION",
  "CHECK_REPLIES",
  "REFRESH_TRENDS",
  "HEALTH_CHECK",
  "RECONCILE",
  "TRIAGE_QUEUE",
  "SCRAPE_METRICS",
  "RECYCLE_CONTENT",
  "AGGREGATE_HOOKS",
] as const;

function buildService(overrides: Partial<Record<(typeof ACTION_TYPES)[number], unknown>> = {}) {
  const handlers = ACTION_TYPES.map((actionType) => ({
    actionType,
    execute: vi.fn().mockResolvedValue({ actionType, processed: true }),
    ...overrides[actionType],
  }));
  return {
    service: new ActionExecutorService(...(handlers as never)),
    handlers,
  };
}

const postAction: Action = {
  type: "POST",
  network: SocialNetwork.X,
  reason: "approved draft",
  source: "rules_fallback",
};

describe("ActionExecutorService", () => {
  it("returns success for WAIT without invoking a handler", async () => {
    const { service, handlers } = buildService();

    const result = await service.execute({
      type: "WAIT",
      reason: "nothing to do",
      source: "rules_fallback",
    });

    expect(result).toMatchObject({ success: true, type: "WAIT", duration: 0 });
    expect(handlers.every((handler) => handler.execute.mock.calls.length === 0)).toBe(true);
  });

  it("routes a typed action to its strategy and returns side effects", async () => {
    const { service, handlers } = buildService();

    const result = await service.execute(postAction);

    expect(result).toMatchObject({ success: true, type: "POST", sideEffects: { processed: true } });
    expect(handlers.find((handler) => handler.actionType === "POST")?.execute).toHaveBeenCalledWith(
      postAction,
      undefined,
    );
  });

  it("returns an error result when a handler throws", async () => {
    const { service } = buildService({
      POST: { execute: vi.fn().mockRejectedValue(new Error("provider unavailable")) },
    });

    const result = await service.execute(postAction);

    expect(result).toMatchObject({
      success: false,
      type: "POST",
      error: "provider unavailable",
    });
  });

  it("does not execute an action when its signal is already aborted", async () => {
    const { service, handlers } = buildService();
    const controller = new AbortController();
    controller.abort();

    const result = await service.execute(postAction, { signal: controller.signal });

    expect(result).toMatchObject({ success: false, type: "POST", error: "Action aborted" });
    expect(handlers.every((handler) => handler.execute.mock.calls.length === 0)).toBe(true);
  });

  it("turns an abort during handler execution into a failed result", async () => {
    const controller = new AbortController();
    const { service } = buildService({
      POST: {
        execute: vi.fn().mockImplementation(async () => {
          controller.abort();
          return { posted: true };
        }),
      },
    });

    const result = await service.execute(postAction, { signal: controller.signal });

    expect(result).toMatchObject({ success: false, type: "POST", error: "Action aborted" });
  });
});
