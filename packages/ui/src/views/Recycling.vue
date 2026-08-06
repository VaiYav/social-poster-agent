<script setup lang="ts">
import { ref, onMounted } from 'vue';
import { Recycle, Play, Clock, RefreshCw } from '@lucide/vue';
import { useApi } from '../composables/useApi';
import { useToast } from '../composables/useToast';
import { Card, Button, SectionHeader, Badge } from '../components/ui';
import LoadingSpinner from '../components/LoadingSpinner.vue';

interface RecyclingCandidate {
  id: string;
  network: string;
  content: string;
  postedAt: string;
}

interface RecyclingConfig {
  enabled: boolean;
  schedule: string;
}

interface RecyclingResult {
  recycled: number;
  skipped: number;
}

interface RecycledPost {
  id: string;
  status: string;
}

const api = useApi();
const toast = useToast();

const candidates = ref<RecyclingCandidate[]>([]);
const config = ref<RecyclingConfig | null>(null);
const loading = ref(false);
const running = ref(false);
const recyclingIds = ref<Set<string>>(new Set());

async function loadCandidates() {
  loading.value = true;
  try {
    const [candidatesRes, configRes] = await Promise.all([
      api.get<RecyclingCandidate[]>('/recycling/candidates'),
      api.get<RecyclingConfig>('/recycling/config'),
    ]);
    candidates.value = candidatesRes.data;
    config.value = configRes.data;
  } catch (err) {
    toast.error((err as Error).message ?? 'Failed to load recycling candidates');
  } finally {
    loading.value = false;
  }
}

async function runRecycling() {
  running.value = true;
  try {
    const res = await api.post<RecyclingResult>('/recycling/run', null, { params: { limit: 10 } });
    toast.success(`Recycling complete: ${res.data.recycled} recycled, ${res.data.skipped} skipped`);
    await loadCandidates();
  } catch (err) {
    toast.error((err as Error).message ?? 'Failed to run recycling');
  } finally {
    running.value = false;
  }
}

async function recycleOne(postId: string) {
  recyclingIds.value.add(postId);
  try {
    const res = await api.post<RecycledPost>(`/recycling/${postId}/recycle`);
    toast.success(`Recycled into new draft: ${res.data.id}`);
    await loadCandidates();
  } catch (err) {
    toast.error((err as Error).message ?? 'Failed to recycle post');
  } finally {
    recyclingIds.value.delete(postId);
  }
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleDateString();
}

onMounted(() => {
  loadCandidates();
});
</script>

<template>
  <div>
    <SectionHeader
      title="Content Recycling"
      description="Refresh old top-performing posts by generating new draft variants (F13)."
    />

    <div class="grid grid-cols-1 gap-6 lg:grid-cols-3">
      <!-- Actions -->
      <Card class="lg:col-span-1">
        <template #header>
          <div class="flex items-center gap-2">
            <Recycle class="h-5 w-5 text-primary" />
            <h2 class="text-lg font-semibold text-text-primary">Actions</h2>
          </div>
        </template>

        <div class="space-y-4">
          <Button
            :loading="running"
            :disabled="running"
            class="w-full"
            @click="runRecycling"
          >
            <Play class="h-4 w-4" />
            Run Recycling Now
          </Button>

          <div
            v-if="config"
            class="flex items-center gap-2 rounded-md border border-border bg-surface-highlight px-3 py-2 text-sm"
          >
            <Clock class="h-4 w-4 text-text-muted" />
            <span class="text-text-secondary">Scheduled cron:</span>
            <Badge :variant="config.enabled ? 'success' : 'default'">
              {{ config.enabled ? 'On' : 'Off' }}
            </Badge>
            <span v-if="config.enabled" class="ml-auto font-mono text-xs text-text-muted">
              {{ config.schedule }}
            </span>
          </div>

          <p class="text-xs text-text-muted">
            New recycled drafts keep DRAFT status and still require approval before posting.
          </p>
        </div>
      </Card>

      <!-- Candidates -->
      <Card class="lg:col-span-2" elevated>
        <template #header>
          <div class="flex items-center justify-between">
            <div class="flex items-center gap-2">
              <RefreshCw class="h-5 w-5 text-secondary" />
              <h2 class="text-lg font-semibold text-text-primary">Recyclable Posts</h2>
            </div>
            <Button variant="ghost" size="sm" :loading="loading" @click="loadCandidates">
              <RefreshCw class="h-4 w-4" />
              Refresh
            </Button>
          </div>
        </template>

        <div v-if="loading && candidates.length === 0" class="flex justify-center py-12">
          <LoadingSpinner message="Loading candidates..." />
        </div>

        <div v-else-if="candidates.length === 0" class="py-8 text-center text-text-muted">
          No posts eligible for recycling yet.
          <p class="mt-1 text-sm">Candidates are posted posts older than 30 days that are not duplicates of recent content.</p>
        </div>

        <div v-else class="space-y-3">
          <div
            v-for="post in candidates"
            :key="post.id"
            class="rounded-md border border-border bg-surface p-4"
          >
            <div class="mb-2 flex items-center justify-between">
              <div class="flex items-center gap-2">
                <Badge>{{ post.network }}</Badge>
                <span class="text-xs text-text-muted">Posted {{ formatDate(post.postedAt) }}</span>
              </div>
              <Button
                size="sm"
                :loading="recyclingIds.has(post.id)"
                :disabled="recyclingIds.has(post.id)"
                @click="recycleOne(post.id)"
              >
                <Recycle class="h-4 w-4" />
                Recycle
              </Button>
            </div>
            <p class="line-clamp-3 text-sm text-text-secondary">
              {{ post.content }}
            </p>
          </div>
        </div>
      </Card>
    </div>
  </div>
</template>
