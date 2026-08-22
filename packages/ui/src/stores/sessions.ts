import { defineStore } from "pinia";
import { ref } from "vue";
import api from "../composables/useApi";
import type { SessionWithAccount } from "@spa/shared";

export interface RateLimitStatus {
  dailyCount: number;
  dailyLimit: number;
  weeklyCount: number;
  weeklyLimit: number;
  lastPostAt: number | null;
  minIntervalMs: number;
}

/**
 * Sessions store — browser session status per network.
 * Used by Sessions view. Includes account relation with warm-up fields.
 * Also fetches rate limit status per network.
 */
export const useSessionsStore = defineStore("sessions", () => {
  const sessions = ref<SessionWithAccount[]>([]);
  const loading = ref(false);
  const error = ref<string | null>(null);
  const rateLimits = ref<Record<string, RateLimitStatus>>({});

  async function fetchAll() {
    loading.value = true;
    error.value = null;
    try {
      const res = await api.get("/sessions");
      sessions.value = res.data;
      // Fetch rate limit status for each network
      const networks = [
        ...new Set(sessions.value.map((s) => s.account?.network).filter(Boolean)),
      ] as string[];
      await Promise.all(networks.map((n) => fetchRateLimit(n)));
    } catch (e: unknown) {
      error.value = (e as Error).message;
    } finally {
      loading.value = false;
    }
  }

  async function fetchRateLimit(network: string) {
    try {
      const res = await api.get(`/rate-limit/${network}/status`);
      rateLimits.value[network] = res.data;
    } catch {
      // Rate limit status is optional — don't set error
    }
  }

  async function healthCheck(network: string) {
    try {
      await api.post("/sessions/health-check", null, { params: { network } });
      await fetchAll();
    } catch (e: unknown) {
      error.value = (e as Error).message;
    }
  }

  return { sessions, loading, error, rateLimits, fetchAll, healthCheck };
});
