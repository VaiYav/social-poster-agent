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

function warmupDaysElapsed(startedAt: string | null): number {
  if (!startedAt) return 0;
  const start = new Date(startedAt).getTime();
  const now = Date.now();
  return Math.floor((now - start) / (1000 * 60 * 60 * 24));
}

function warmupPhase(days: number): string {
  if (days <= 2) return 'Browse-only (days 1-2)';
  if (days <= 5) return 'Light interactions (days 3-5)';
  if (days <= 7) return 'Moderate (days 6-7)';
  return 'Full activity (day 8+)';
}

function rateLimitFor(network: string | undefined) {
  if (!network) return null;
  return sessionsStore.rateLimits[network] ?? null;
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
          <div class="flex items-center gap-2">
            <span class="text-sm font-medium text-gray-700">{{ session.account?.network ?? 'Unknown' }}</span>
            <span class="text-xs text-gray-400">@{{ session.account?.handle ?? 'N/A' }}</span>
          </div>
          <span class="rounded px-2 py-0.5 text-xs" :class="{
            'bg-green-100 text-green-700': session.status === 'ACTIVE',
            'bg-yellow-100 text-yellow-700': session.status === 'EXPIRED',
            'bg-blue-100 text-blue-700': session.status === 'WARMUP',
            'bg-red-100 text-red-700': session.status === 'ERROR' || session.status === 'BANNED',
          }">{{ session.status }}</span>
        </div>

        <!-- Warm-up status (F20) -->
        <div v-if="session.account?.warmupEnabled" class="mt-2 rounded bg-blue-50 p-2">
          <div class="flex items-center gap-2">
            <span class="text-xs font-medium text-blue-700">Warm-up Mode</span>
            <span class="text-xs text-blue-500">
              Day {{ warmupDaysElapsed(session.account?.warmupStartedAt ?? null) }} / {{ session.account?.warmupDaysTotal ?? 7 }}
            </span>
          </div>
          <p class="mt-1 text-xs text-blue-600">
            {{ warmupPhase(warmupDaysElapsed(session.account?.warmupStartedAt ?? null)) }}
          </p>
        </div>

        <div class="mt-2 text-xs text-gray-500">
          Last check: {{ session.lastHealthCheck ?? 'never' }}
        </div>

        <!-- Rate limit status -->
        <div v-if="rateLimitFor(session.account?.network)" class="mt-2 rounded bg-gray-50 p-2">
          <div class="flex items-center justify-between text-xs">
            <span class="font-medium text-gray-600">Rate Limits</span>
            <span :class="{
              'text-green-600': rateLimitFor(session.account?.network)!.dailyCount < rateLimitFor(session.account?.network)!.dailyLimit,
              'text-red-600': rateLimitFor(session.account?.network)!.dailyCount >= rateLimitFor(session.account?.network)!.dailyLimit,
            }">
              {{ rateLimitFor(session.account?.network)!.dailyCount }} / {{ rateLimitFor(session.account?.network)!.dailyLimit }} daily
            </span>
          </div>
          <div class="mt-1 flex items-center justify-between text-xs text-gray-500">
            <span>Weekly: {{ rateLimitFor(session.account?.network)!.weeklyCount }} / {{ rateLimitFor(session.account?.network)!.weeklyLimit }}</span>
            <span v-if="rateLimitFor(session.account?.network)!.lastPostAt">
              Last: {{ new Date(rateLimitFor(session.account?.network)!.lastPostAt!).toLocaleTimeString() }}
            </span>
            <span v-else>No posts today</span>
          </div>
        </div>

        <button @click="healthCheck(session.account?.network ?? '')" class="mt-2 rounded bg-gray-100 px-3 py-1 text-xs hover:bg-gray-200">
          Health Check
        </button>
      </div>
    </div>
  </div>
</template>
