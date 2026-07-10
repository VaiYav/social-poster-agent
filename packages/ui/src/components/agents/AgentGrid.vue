<script setup lang="ts">
import { ref } from 'vue';
import { useAgentsStore } from '../../stores/agents';
import AgentCard from './AgentCard.vue';

const agentsStore = useAgentsStore();
const loadingAction = ref<string | null>(null);

async function onAction(actionId: string, agentId: string) {
  loadingAction.value = actionId;
  try {
    await agentsStore.execute(actionId, agentId);
  } finally {
    loadingAction.value = null;
  }
}
</script>

<template>
  <div class="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
    <AgentCard
      v-for="agent in agentsStore.agents"
      :key="agent.id"
      :agent="agent"
      :loading-action="loadingAction"
      @action="onAction"
    />
  </div>
</template>
