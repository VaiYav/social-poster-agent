/**
 * ADR-006: Flow Control store — pause/resume agent flows.
 */
import { defineStore } from 'pinia';
import { ref } from 'vue';
import { useApi } from '../composables/useApi';
import type { SSEvent } from '@spa/shared';

export type FlowName = 'generation' | 'posting' | 'engagement' | 'replies' | 'llm_triage' | 'auto_approve';

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
    llm_triage: false,
    auto_approve: false,
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

  function handleSseEvent(data: SSEvent) {
    if (data.type !== 'flow_control') return;
    const flow = data.flow;
    if (data.action === 'pause_all') {
      pauseAll.value = true;
      if (flow) flows.value[flow] = true;
      else for (const f of Object.keys(flows.value) as FlowName[]) flows.value[f] = true;
    } else if (data.action === 'resume_all') {
      pauseAll.value = false;
      for (const f of Object.keys(flows.value) as FlowName[]) flows.value[f] = false;
    } else if (data.action === 'paused' && flow) {
      flows.value[flow] = true;
      if (Object.values(flows.value).every(Boolean)) pauseAll.value = true;
    } else if (data.action === 'resumed' && flow) {
      flows.value[flow] = false;
      pauseAll.value = false;
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
    handleSseEvent,
  };
});
