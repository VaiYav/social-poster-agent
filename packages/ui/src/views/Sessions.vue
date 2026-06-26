<script setup lang="ts">
import { onMounted } from 'vue';
import { useSessionsStore } from '../stores/sessions';
import LoadingSpinner from '../components/LoadingSpinner.vue';
import ErrorState from '../components/ErrorState.vue';
import EmptyState from '../components/EmptyState.vue';

const sessionsStore = useSessionsStore();

onMounted(() => sessionsStore.fetchAll());

async function healthCheck(network: string) {
  await sessionsStore.healthCheck(network);
}
</script>

<template>
  <div>
    <h1 class="text-2xl font-bold text-gray-900">Sessions</h1>

    <LoadingSpinner v-if="sessionsStore.loading" />
    <ErrorState v-else-if="sessionsStore.error" :message="sessionsStore.error" />
    <EmptyState v-else-if="sessionsStore.sessions.length === 0" message="No sessions configured." />
    <div v-else class="mt-6 space-y-3">
      <div v-for="session in sessionsStore.sessions" :key="session.id" class="rounded-lg border border-gray-200 bg-white p-4">
        <div class="flex items-center justify-between">
          <span class="text-sm font-medium text-gray-700">Account: {{ session.accountId }}</span>
          <span class="rounded px-2 py-0.5 text-xs" :class="{
            'bg-green-100 text-green-700': session.status === 'ACTIVE',
            'bg-yellow-100 text-yellow-700': session.status === 'EXPIRED',
            'bg-red-100 text-red-700': session.status === 'ERROR',
          }">{{ session.status }}</span>
        </div>
        <div class="mt-2 text-xs text-gray-500">
          Last check: {{ session.lastHealthCheck ?? 'never' }}
        </div>
        <button @click="healthCheck(session.accountId)" class="mt-2 rounded bg-gray-100 px-3 py-1 text-xs hover:bg-gray-200">
          Health Check
        </button>
      </div>
    </div>
  </div>
</template>
