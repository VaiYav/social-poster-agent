import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { TrendingService } from "../../../src/modules/trending/trending.service.js";
import { createMockConfigService } from "../../mocks/index.js";

describe("TrendingService", () => {
  const temporaryDirectories: string[] = [];

  afterEach(() => {
    for (const directory of temporaryDirectories.splice(0)) {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("uses an empty event list when no path is configured", () => {
    const service = new TrendingService(createMockConfigService());

    expect(service.getTrendingTopics()).toEqual([]);
  });

  it("loads the configured event file through ConfigService", () => {
    const directory = mkdtempSync(join(tmpdir(), "spa-trending-"));
    temporaryDirectories.push(directory);
    const path = join(directory, "events.json");
    writeFileSync(
      path,
      JSON.stringify([
        {
          name: "Product launch",
          date: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
          windowDays: 30,
          topic: "Product launch energy",
          networks: ["X"],
        },
      ]),
    );

    const service = new TrendingService(createMockConfigService({ TRENDING_EVENTS_PATH: path }));

    expect(service.getActiveTrending()).toEqual([
      {
        event: "Product launch",
        topic: "Product launch energy",
        daysUntil: expect.any(Number),
        trending: true,
        networks: ["X"],
        windowDays: 30,
      },
    ]);
  });
});
