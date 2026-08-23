import { describe, expect, it, vi } from "vitest";
import { CollectorPipeline } from "../../../src/modules/orchestrator/collector-pipeline.js";

describe("CollectorPipeline", () => {
  it("runs named collectors in parallel and preserves successful values", async () => {
    const pipeline = new CollectorPipeline();
    const order: string[] = [];
    const result = await pipeline.run({
      fast: {
        name: "fast",
        collect: vi.fn(async () => {
          order.push("fast:start");
          await Promise.resolve();
          order.push("fast:end");
          return 1;
        }),
      },
      slow: {
        name: "slow",
        collect: vi.fn(async () => {
          order.push("slow:start");
          await Promise.resolve();
          order.push("slow:end");
          return "ok";
        }),
      },
    });

    expect(result).toEqual({
      fast: { ok: true, value: 1 },
      slow: { ok: true, value: "ok" },
    });
    expect(order.indexOf("slow:start")).toBeGreaterThanOrEqual(0);
  });

  it("captures Error failures without aborting other collectors", async () => {
    const good = vi.fn().mockResolvedValue("healthy");
    const bad = vi.fn().mockRejectedValue(new Error("database unavailable"));
    const result = await new CollectorPipeline().run({
      good: { name: "good", collect: good },
      bad: { name: "bad", collect: bad },
    });

    expect(result.good).toEqual({ ok: true, value: "healthy" });
    expect(result.bad).toMatchObject({ ok: false, error: new Error("database unavailable") });
    expect(good).toHaveBeenCalledOnce();
  });

  it("normalizes non-Error failures and undefined collector entries", async () => {
    const result = await new CollectorPipeline().run({
      primitive: {
        name: "primitive",
        collect: () => {
          throw "bad value";
        },
      },
      missing: undefined,
    } as never);

    expect(result.primitive).toMatchObject({ ok: false, error: new Error("bad value") });
    expect(result.missing).toMatchObject({
      ok: false,
      error: new Error("Collector missing is undefined"),
    });
  });
});
