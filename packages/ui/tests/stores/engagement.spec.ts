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

import { useEngagementStore } from "../../src/stores/engagement";
import api from "../../src/composables/useApi";
import type { SSEvent } from "@spa/shared";

describe("engagement store", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.clearAllMocks();
  });

  it("initial state is empty and not loading", () => {
    const store = useEngagementStore();
    expect(store.scheduler).toBeNull();
    expect(store.stats).toBeNull();
    expect(store.browsingSessions).toEqual([]);
    expect(store.interactions).toEqual([]);
    expect(store.loading).toBe(false);
    expect(store.error).toBeNull();
    expect(store.isEnabled).toBe(false);
  });

  it("fetchSchedulerStatus populates scheduler", async () => {
    const scheduler = {
      enabled: true,
      sessionsPerDay: 3,
      windows: ["09:00", "13:00", "18:00"],
      networks: ["X", "THREADS"],
      jitterMinutes: 30,
      pendingSessions: 2,
    };
    (api.get as ReturnType<typeof vi.fn>).mockResolvedValue({ data: scheduler });

    const store = useEngagementStore();
    await store.fetchSchedulerStatus();

    expect(api.get).toHaveBeenCalledWith("/engagement/scheduler/status");
    expect(store.scheduler).toEqual(scheduler);
    expect(store.isEnabled).toBe(true);
  });

  it("fetchStats populates stats", async () => {
    const stats = { total: 10, completed: 8, failed: 2, byType: { like: 5, comment: 3 } };
    (api.get as ReturnType<typeof vi.fn>).mockResolvedValue({ data: stats });

    const store = useEngagementStore();
    await store.fetchStats("X");

    expect(api.get).toHaveBeenCalledWith("/engagement/stats?network=X");
    expect(store.stats).toEqual(stats);
  });

  it("fetchBrowsingSessions populates sessions", async () => {
    const sessions = [
      {
        id: "s1",
        network: "X",
        status: "COMPLETED",
        postsViewed: 12,
        interactionsCount: 3,
        startedAt: "2026-08-07T12:00:00.000Z",
      },
    ];
    (api.get as ReturnType<typeof vi.fn>).mockResolvedValue({ data: sessions });

    const store = useEngagementStore();
    await store.fetchBrowsingSessions();

    expect(api.get).toHaveBeenCalledWith("/engagement/browsing-sessions?limit=10");
    expect(store.browsingSessions).toEqual(sessions);
  });

  it("startBrowsingSession posts with network and duration", async () => {
    const session = { id: "s2", network: "THREADS", status: "ACTIVE" };
    (api.post as ReturnType<typeof vi.fn>).mockResolvedValue({ data: session });

    const store = useEngagementStore();
    const result = await store.startBrowsingSession("THREADS", 600);

    expect(api.post).toHaveBeenCalledWith("/engagement/browsing-session", {
      network: "THREADS",
      durationSec: 600,
    });
    expect(result).toEqual(session);
  });

  it("fetchAll fetches all endpoints", async () => {
    (api.get as ReturnType<typeof vi.fn>).mockImplementation((url: string) => {
      if (url.startsWith("/engagement/scheduler/status"))
        return Promise.resolve({ data: { enabled: true } });
      if (url.startsWith("/engagement/stats")) return Promise.resolve({ data: { total: 1 } });
      if (url.startsWith("/engagement/browsing-sessions")) return Promise.resolve({ data: [] });
      if (url.startsWith("/engagement/interactions")) return Promise.resolve({ data: [] });
      return Promise.resolve({ data: null });
    });

    const store = useEngagementStore();
    await store.fetchAll("X");

    expect(api.get).toHaveBeenCalledWith("/engagement/scheduler/status");
    expect(api.get).toHaveBeenCalledWith("/engagement/stats?network=X");
    expect(api.get).toHaveBeenCalledWith("/engagement/browsing-sessions?limit=10&network=X");
    expect(api.get).toHaveBeenCalledWith("/engagement/interactions?limit=20&network=X");
    expect(store.loading).toBe(false);
  });

  it("sets error on failed API call", async () => {
    (api.get as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("Network down"));

    const store = useEngagementStore();
    await store.fetchAll();

    expect(store.error).toBe("Network down");
    expect(store.loading).toBe(false);
  });

  it("handleSseEvent refetches all on browsing session events", async () => {
    (api.get as ReturnType<typeof vi.fn>).mockResolvedValue({ data: [] });

    const store = useEngagementStore();
    const event = {
      type: "browsing_session_completed",
      network: "X",
      sessionId: "s1",
      postsViewed: 5,
      interactionsCount: 1,
    } as unknown as SSEvent;
    store.handleSseEvent(event);

    await new Promise((r) => setTimeout(r, 10));
    expect(api.get).toHaveBeenCalled();
  });
});
