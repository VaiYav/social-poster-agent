import { defineStore } from 'pinia';
import { ref } from 'vue';
import api from '../composables/useApi';
import type { Session } from '@spa/shared';

/**
 * Sessions store — browser session status per network.
 * Used by Sessions view.
 */
export const useSessionsStore = defineStore('sessions', () => {
  const sessions = ref<Session[]>([]);
  const loading = ref(false);
  const error = ref<string | null>(null);

  async function fetchAll() {
    loading.value = true;
    error.value = null;
    try {
      const res = await api.get('/sessions');
      sessions.value = res.data;
    } catch (e: unknown) {
      error.value = (e as Error).message;
    } finally {
      loading.value = false;
    }
  }

  async function healthCheck(network: string) {
    try {
      await api.post('/sessions/health-check', null, { params: { network } });
      await fetchAll();
    } catch (e: unknown) {
      error.value = (e as Error).message;
    }
  }

  return { sessions, loading, error, fetchAll, healthCheck };
});
