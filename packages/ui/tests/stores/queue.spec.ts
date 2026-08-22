import { describe, it, expect, vi, beforeEach } from "vitest";
import { setActivePinia, createPinia } from "pinia";

// Mock the axios API client before importing the store
vi.mock("../../src/composables/useApi", () => {
  const api = {
    get: vi.fn(),
    post: vi.fn(),
  };
  return { default: api, useApi: () => api };
});

import { useQueueStore } from "../../src/stores/queue";
import api from "../../src/composables/useApi";

describe("MOD-06 / queue store", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.clearAllMocks();
  });

  // ---------------------------------------------------------------------------
  // UTC-105 — fetchStats(network) populates stats object
  // ---------------------------------------------------------------------------
  it("UTC-105: fetchStats(network) populates stats[network] with queue counts", async () => {
    const statsData = { waiting: 5, active: 2, completed: 10, failed: 1, delayed: 3 };
    (api.get as ReturnType<typeof vi.fn>).mockImplementation((url: string) =>
      url.endsWith("/paused")
        ? Promise.resolve({ data: { paused: false } })
        : Promise.resolve({ data: statsData }),
    );

    const store = useQueueStore();
    await store.fetchStats("X");

    expect(api.get).toHaveBeenCalledWith("/queue/X/stats");
    expect(store.stats["X"]).toEqual(statsData);
    expect(store.stats["X"]?.waiting).toBe(5);
    expect(store.stats["X"]?.active).toBe(2);
    expect(store.stats["X"]?.completed).toBe(10);
    expect(store.stats["X"]?.failed).toBe(1);
    expect(store.stats["X"]?.delayed).toBe(3);
    expect(store.paused["X"]).toBe(false);
    expect(store.loading).toBe(false);
    expect(store.error).toBeNull();
  });

  // ---------------------------------------------------------------------------
  // UTC-106 — fetchStats() sets error on API failure
  // ---------------------------------------------------------------------------
  it("UTC-106: fetchStats(network) sets error and clears loading on API failure", async () => {
    (api.get as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("Queue API down"));

    const store = useQueueStore();
    await store.fetchStats("X");

    expect(store.error).toBe("Queue API down");
    expect(store.loading).toBe(false);
    // stats for this network should not have been set
    expect(store.stats["X"]).toBeUndefined();
  });

  // ---------------------------------------------------------------------------
  // UTC-107 — fetchFailed(network) populates failedJobs
  // ---------------------------------------------------------------------------
  it("UTC-107: fetchFailed(network) populates failedJobs[network] array", async () => {
    const failedData = [
      { id: "job1", data: { postId: "p1" }, failedReason: "timeout", timestamp: 1700000000 },
    ];
    (api.get as ReturnType<typeof vi.fn>).mockResolvedValue({ data: failedData });

    const store = useQueueStore();
    await store.fetchFailed("X");

    expect(api.get).toHaveBeenCalledWith("/queue/X/failed");
    expect(store.failedJobs["X"]).toEqual(failedData);
    expect(store.failedJobs["X"]).toHaveLength(1);
    expect(store.failedJobs["X"]?.[0].id).toBe("job1");
    expect(store.failedJobs["X"]?.[0].failedReason).toBe("timeout");
  });

  // ---------------------------------------------------------------------------
  // fetchAll() — fetches stats and failed for all 3 networks
  // ---------------------------------------------------------------------------
  it("fetchAll() fetches stats and failed jobs for X, THREADS, and FACEBOOK", async () => {
    (api.get as ReturnType<typeof vi.fn>).mockImplementation((url: string) =>
      url.endsWith("/paused")
        ? Promise.resolve({ data: { paused: false } })
        : Promise.resolve({ data: { waiting: 0, active: 0, completed: 0, failed: 0, delayed: 0 } }),
    );

    const store = useQueueStore();
    await store.fetchAll();

    // 3 networks × 3 calls (stats + failed + paused) = 9 GET calls
    expect(api.get).toHaveBeenCalledTimes(9);
    expect(api.get).toHaveBeenCalledWith("/queue/X/stats");
    expect(api.get).toHaveBeenCalledWith("/queue/X/failed");
    expect(api.get).toHaveBeenCalledWith("/queue/X/paused");
    expect(api.get).toHaveBeenCalledWith("/queue/THREADS/stats");
    expect(api.get).toHaveBeenCalledWith("/queue/THREADS/failed");
    expect(api.get).toHaveBeenCalledWith("/queue/THREADS/paused");
    expect(api.get).toHaveBeenCalledWith("/queue/FACEBOOK/stats");
    expect(api.get).toHaveBeenCalledWith("/queue/FACEBOOK/failed");
    expect(api.get).toHaveBeenCalledWith("/queue/FACEBOOK/paused");
  });

  // ---------------------------------------------------------------------------
  // F5 — pauseQueue / resumeQueue
  // ---------------------------------------------------------------------------
  it("F5: pauseQueue(network) calls POST /queue/:network/pause and sets paused=true", async () => {
    (api.post as ReturnType<typeof vi.fn>).mockResolvedValue({
      data: { paused: true, network: "X" },
    });

    const store = useQueueStore();
    await store.pauseQueue("X");

    expect(api.post).toHaveBeenCalledWith("/queue/X/pause");
    expect(store.paused["X"]).toBe(true);
  });

  it("F5: resumeQueue(network) calls POST /queue/:network/resume and sets paused=false", async () => {
    (api.post as ReturnType<typeof vi.fn>).mockResolvedValue({
      data: { paused: false, network: "X" },
    });

    const store = useQueueStore();
    store.paused["X"] = true;
    await store.resumeQueue("X");

    expect(api.post).toHaveBeenCalledWith("/queue/X/resume");
    expect(store.paused["X"]).toBe(false);
  });

  // ---------------------------------------------------------------------------
  // UTC-114 (queue portion) — initial state
  // ---------------------------------------------------------------------------
  it("UTC-114 (queue): initial state has loading=false, error=null, empty objects", () => {
    const store = useQueueStore();
    expect(store.loading).toBe(false);
    expect(store.error).toBeNull();
    expect(store.stats).toEqual({});
    expect(store.failedJobs).toEqual({});
  });
});
