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

import { useSessionsStore } from "../../src/stores/sessions";
import api from "../../src/composables/useApi";
import type { Session } from "@spa/shared";

function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    id: "s1",
    accountId: "acc-1",
    status: "ACTIVE",
    lastHealthCheck: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("MOD-06 / sessions store", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.clearAllMocks();
  });

  // ---------------------------------------------------------------------------
  // UTC-108 — fetchAll() populates sessions array
  // ---------------------------------------------------------------------------
  it("UTC-108: fetchAll() populates sessions array and clears error", async () => {
    const sessionData = [makeSession({ id: "s1", status: "ACTIVE" })];
    (api.get as ReturnType<typeof vi.fn>).mockResolvedValue({ data: sessionData });

    const store = useSessionsStore();
    await store.fetchAll();

    expect(api.get).toHaveBeenCalledWith("/sessions");
    expect(store.sessions).toHaveLength(1);
    expect(store.sessions).toEqual(sessionData);
    expect(store.sessions[0].id).toBe("s1");
    expect(store.sessions[0].status).toBe("ACTIVE");
    expect(store.loading).toBe(false);
    expect(store.error).toBeNull();
  });

  // ---------------------------------------------------------------------------
  // UTC-109 — healthCheck(network) calls API and updates session status
  //
  // The store's healthCheck() calls api.post('/sessions/health-check') and then
  // re-fetches all sessions via fetchAll(). The "session status updated in
  // local state" is achieved through the subsequent fetchAll() call.
  // ---------------------------------------------------------------------------
  it("UTC-109: healthCheck(network) calls API post and refreshes sessions via fetchAll", async () => {
    // First call: health-check POST
    (api.post as ReturnType<typeof vi.fn>).mockResolvedValue({
      data: { healthy: false, message: "expired" },
    });
    // Second call: fetchAll GET (returns updated session with EXPIRED status)
    const updatedSessions = [makeSession({ id: "s1", status: "EXPIRED" })];
    (api.get as ReturnType<typeof vi.fn>).mockResolvedValue({ data: updatedSessions });

    const store = useSessionsStore();
    // Pre-populate with an active session
    store.$patch({ sessions: [makeSession({ id: "s1", status: "ACTIVE" })] });

    await store.healthCheck("X");

    // API post called with health-check endpoint and network param
    expect(api.post).toHaveBeenCalledWith("/sessions/health-check", null, {
      params: { network: "X" },
    });
    // fetchAll was called (GET /sessions) to refresh state
    expect(api.get).toHaveBeenCalledWith("/sessions");
    // Session status updated in local state via the re-fetch
    expect(store.sessions).toHaveLength(1);
    expect(store.sessions[0].status).toBe("EXPIRED");
  });

  // ---------------------------------------------------------------------------
  // healthCheck() sets error on API failure
  // ---------------------------------------------------------------------------
  it("healthCheck(network) sets error when API post fails", async () => {
    (api.post as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("Health check failed"));

    const store = useSessionsStore();
    await store.healthCheck("X");

    expect(store.error).toBe("Health check failed");
    // fetchAll should NOT have been called since the post threw
    expect(api.get).not.toHaveBeenCalled();
  });

  // ---------------------------------------------------------------------------
  // fetchAll() sets error on API failure
  // ---------------------------------------------------------------------------
  it("fetchAll() sets error and clears loading on API failure", async () => {
    (api.get as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("Sessions API down"));

    const store = useSessionsStore();
    await store.fetchAll();

    expect(store.error).toBe("Sessions API down");
    expect(store.loading).toBe(false);
    expect(store.sessions).toEqual([]);
  });

  // ---------------------------------------------------------------------------
  // UTC-114 (sessions portion) — initial state
  // ---------------------------------------------------------------------------
  it("UTC-114 (sessions): initial state has loading=false, error=null, empty array", () => {
    const store = useSessionsStore();
    expect(store.loading).toBe(false);
    expect(store.error).toBeNull();
    expect(store.sessions).toEqual([]);
  });
});
