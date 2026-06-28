<script setup lang="ts">
import { ref, computed, onMounted, watch } from 'vue';
import { History, CheckCircle2, XCircle, Ban, Search } from '@lucide/vue';
import { usePostsStore } from '../stores/posts';
import { Card, Button, SectionHeader, Input, Select } from '../components/ui';
import PostCard from '../components/PostCard.vue';
import LoadingSpinner from '../components/LoadingSpinner.vue';
import ErrorState from '../components/ErrorState.vue';
import EmptyState from '../components/EmptyState.vue';

const postsStore = usePostsStore();
const filter = ref<'POSTED' | 'FAILED' | 'REJECTED'>('POSTED');
const searchQuery = ref('');
const networkFilter = ref<'ALL' | 'X' | 'THREADS' | 'FACEBOOK'>('ALL');
const sortBy = ref<'recent' | 'oldest'>('recent');

async function loadPosts() {
  await postsStore.fetchPosts({ status: filter.value, limit: 100 });
}

onMounted(loadPosts);
watch(filter, loadPosts);

const filters = [
  { value: 'POSTED', label: 'Posted', icon: CheckCircle2, color: 'text-status-posted' },
  { value: 'FAILED', label: 'Failed', icon: XCircle, color: 'text-status-failed' },
  { value: 'REJECTED', label: 'Rejected', icon: Ban, color: 'text-status-rejected' },
] as const;

const activeFilter = filters.find(f => f.value === filter.value);

// Client-side filtering on loaded posts
const filteredPosts = computed(() => {
  let posts = postsStore.posts;

  // Network filter
  if (networkFilter.value !== 'ALL') {
    posts = posts.filter(p => p.network === networkFilter.value);
  }

  // Search query (content + sourceRef.topic)
  if (searchQuery.value.trim()) {
    const q = searchQuery.value.toLowerCase();
    posts = posts.filter(p => {
      const topic = (p.sourceRef as { topic?: string } | null)?.topic;
      return p.content.toLowerCase().includes(q) ||
        (topic?.toLowerCase().includes(q) ?? false);
    });
  }

  // Sort
  if (sortBy.value === 'oldest') {
    posts = [...posts].sort((a, b) =>
      new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
    );
  }

  return posts;
});
</script>

<template>
  <div>
    <SectionHeader
      title="History"
      description="Browse, search, and filter past posts."
    />

    <Card class="mb-6">
      <template #header>
        <div class="flex items-center gap-2">
          <History class="h-5 w-5 text-primary" />
          <h2 class="text-lg font-semibold text-text-primary">Filter & Search</h2>
        </div>
      </template>

      <!-- Status filter buttons -->
      <div class="flex flex-wrap gap-2 mb-4">
        <Button
          v-for="f in filters"
          :key="f.value"
          :variant="filter === f.value ? 'primary' : 'outline'"
          size="sm"
          @click="filter = f.value"
        >
          <component :is="f.icon" class="h-4 w-4" :class="f.color" />
          {{ f.label }}
        </Button>
      </div>

      <!-- Search + network + sort -->
      <div class="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <div class="relative">
          <Search class="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-text-muted" />
          <Input
            v-model="searchQuery"
            placeholder="Search content or topic..."
            class="pl-10"
          />
        </div>
        <Select
          :model-value="networkFilter"
          :options="[
            { value: 'ALL', label: 'All networks' },
            { value: 'X', label: 'X (Twitter)' },
            { value: 'THREADS', label: 'Threads' },
            { value: 'FACEBOOK', label: 'Facebook' },
          ]"
          @update:model-value="networkFilter = $event as typeof networkFilter"
        />
        <Select
          :model-value="sortBy"
          :options="[
            { value: 'recent', label: 'Most recent first' },
            { value: 'oldest', label: 'Oldest first' },
          ]"
          @update:model-value="sortBy = $event as typeof sortBy"
        />
      </div>

      <p class="mt-4 text-sm text-text-secondary">
        Showing <span class="font-medium text-text-primary">{{ activeFilter?.label }}</span> posts
        <span class="text-text-muted">({{ filteredPosts.length }} of {{ postsStore.posts.length }} loaded)</span>
      </p>
    </Card>

    <LoadingSpinner v-if="postsStore.loading" />
    <ErrorState v-else-if="postsStore.error" :message="postsStore.error" />
    <EmptyState v-else-if="filteredPosts.length === 0" :message="`No posts match your filters.`" />
    <div v-else class="space-y-4">
      <PostCard
        v-for="post in filteredPosts"
        :key="post.id"
        :post="post"
        :truncate="120"
      />
    </div>
  </div>
</template>
