<script setup lang="ts">
import { ref, onMounted } from 'vue';
import { useStatsStore } from '../stores/stats';
import LoadingSpinner from '../components/LoadingSpinner.vue';
import ErrorState from '../components/ErrorState.vue';
import EmptyState from '../components/EmptyState.vue';

const statsStore = useStatsStore();

const count = ref(3);
const networks = ref<string[]>(['X', 'THREADS', 'FACEBOOK']);
const sourceType = ref<'brief' | 'article' | 'topic' | 'create_run'>('brief');
const generating = ref(false);
const result = ref<string | null>(null);
const resultError = ref<string | null>(null);

onMounted(() => statsStore.fetchRuns());

async function generate() {
  generating.value = true;
  result.value = null;
  resultError.value = null;
  try {
    const data = await statsStore.triggerGeneration(count.value, networks.value, sourceType.value);
    result.value = `Generation started: ${data.runId ?? 'ok'}`;
  } catch (e: unknown) {
    resultError.value = (e as Error).message;
  } finally {
    generating.value = false;
  }
}
</script>

<template>
  <div>
    <h1 class="text-2xl font-bold text-gray-900">Generate Posts</h1>

    <div class="mt-6 max-w-md space-y-4 rounded-lg border border-gray-200 bg-white p-6">
      <div>
        <label class="text-sm font-medium text-gray-700">Count</label>
        <input v-model.number="count" type="number" min="1" max="10" class="mt-1 w-full rounded border border-gray-300 px-3 py-2" />
      </div>
      <div>
        <label class="text-sm font-medium text-gray-700">Source Type</label>
        <select v-model="sourceType" class="mt-1 w-full rounded border border-gray-300 px-3 py-2">
          <option value="brief">Brief</option>
          <option value="article">Article</option>
          <option value="topic">Topic</option>
          <option value="create_run">Create Run</option>
        </select>
      </div>
      <div>
        <label class="text-sm font-medium text-gray-700">Networks</label>
        <div class="mt-1 flex gap-4">
          <label v-for="net in ['X', 'THREADS', 'FACEBOOK']" :key="net" class="flex items-center gap-2">
            <input type="checkbox" :value="net" v-model="networks" class="rounded" />
            <span class="text-sm">{{ net }}</span>
          </label>
        </div>
      </div>
      <button @click="generate" :disabled="generating" class="w-full rounded bg-blue-600 px-4 py-2 text-white hover:bg-blue-700 disabled:opacity-50">
        {{ generating ? 'Generating...' : 'Generate' }}
      </button>
      <p v-if="result" class="text-sm text-green-600">{{ result }}</p>
      <p v-if="resultError" class="text-sm text-red-600">Error: {{ resultError }}</p>
    </div>

    <h2 class="mt-8 text-lg font-semibold text-gray-900">Generation Runs</h2>
    <LoadingSpinner v-if="statsStore.loading" />
    <ErrorState v-else-if="statsStore.error" :message="statsStore.error" />
    <EmptyState v-else-if="statsStore.runs.length === 0" message="No generation runs yet." />
    <div v-else class="mt-4 space-y-2">
      <div v-for="run in statsStore.runs" :key="run.id" class="rounded border border-gray-200 bg-white p-3">
        <div class="flex items-center justify-between">
          <span class="text-xs font-medium text-gray-600">{{ run.triggeredBy }}</span>
          <span class="text-xs" :class="{
            'text-green-600': run.status === 'COMPLETED',
            'text-yellow-600': run.status === 'RUNNING',
            'text-red-600': run.status === 'FAILED',
          }">{{ run.status }}</span>
        </div>
        <div class="mt-1 text-xs text-gray-500">
          {{ run._count.posts }} posts · {{ new Date(run.startedAt).toLocaleString() }}
        </div>
        <p v-if="run.errorMessage" class="mt-1 text-xs text-red-600">{{ run.errorMessage }}</p>
      </div>
    </div>
  </div>
</template>
