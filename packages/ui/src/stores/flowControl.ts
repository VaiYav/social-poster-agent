/**
 * ADR-006: Flow Control store — pause/resume agent flows.
 */
import { defineStore } from 'pinia';
import { ref } from 'vue';
import { useApi } from '../composables/useApi';

export type FlowName = 'generation' | 'posting' | 'engagement' | 'replies';

interface FlowStatus {
  pauseAll: boolean;
  flows: Record<FlowName, boolean>;
}

export const useFlowControlStore = defineStore('flowControl', () => {
  const api = useApi();
  const pauseAll = ref(false);
  const flows = ref<Record<FlowName, boolean>>({
    generation: false,
    posting: false,
    engagement: false,
    replies: false,
  });
  const loading = ref(false);
  const error = ref<string | null>(null);

  async function fetchStatus() {
    loading.value = true;
    error.value = null;
    try {
      const res = await api.get<FlowStatus>('/flow-control/status');
      pauseAll.value = res.data.pauseAll;
      flows.value = res.data.flows;
    } catch (err) {
      error.value = (err as Error).message;
    } finally {
      loading.value = false;
    }
  }

  async function pauseFlow(flow: FlowName, reason?: string) {
    try {
      await api.post(`/flow-control/pause/${flow}`, { reason });
      await fetchStatus();
    } catch (err) {
      error.value = (err as Error).message;
    }
  }

  async function resumeFlow(flow: FlowName) {
    try {
      await api.post(`/flow-control/resume/${flow}`);
      await fetchStatus();
    } catch (err) {
      error.value = (err as Error).message;
    }
  }

  async function pauseAllFlows(reason?: string) {
    try {
      await api.post('/flow-control/pause-all', { reason });
      await fetchStatus();
    } catch (err) {
      error.value = (err as Error).message;
    }
  }

  async function resumeAllFlows() {
    try {
      await api.post('/flow-control/resume-all');
      await fetchStatus();
    } catch (err) {
      error.value = (err as Error).message;
    }
  }

  return {
    pauseAll,
    flows,
    loading,
    error,
    fetchStatus,
    pauseFlow,
    resumeFlow,
    pauseAllFlows,
    resumeAllFlows,
  };
});
