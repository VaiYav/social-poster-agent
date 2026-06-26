<script setup lang="ts">
import { onMounted } from 'vue';
import { usePostsStore } from '../stores/posts';
import { useStatsStore } from '../stores/stats';
import StatCard from '../components/StatCard.vue';
import PostCard from '../components/PostCard.vue';
import LoadingSpinner from '../components/LoadingSpinner.vue';
import ErrorState from '../components/ErrorState.vue';

const postsStore = usePostsStore();
const statsStore = useStatsStore();

onMounted(async () => {
  await Promise.all([
    statsStore.fetchStats(),
    postsStore.fetchPosts({ limit: 5 }),
  ]);
});
</script>

<template>
  <div>
    <h1 class="text-2xl font-bold text-gray-900">Dashboard</h1>

    <LoadingSpinner v-if="statsStore.loading" />
    <ErrorState v-else-if="statsStore.error" :message="statsStore.error" />
    <template v-else>
      <div class="mt-6 grid grid-cols-5 gap-4">
        <StatCard label="Drafts" :value="statsStore.stats.drafts" color="text-yellow-600" />
        <StatCard label="Approved" :value="statsStore.stats.approved" color="text-blue-600" />
        <StatCard label="Posted" :value="statsStore.stats.posted" color="text-green-600" />
        <StatCard label="Failed" :value="statsStore.stats.failed" color="text-red-600" />
        <StatCard label="Rejected" :value="statsStore.stats.rejected" color="text-gray-500" />
      </div>
    </template>

    <h2 class="mt-8 text-lg font-semibold text-gray-900">Recent Posts</h2>
    <LoadingSpinner v-if="postsStore.loading" />
    <ErrorState v-else-if="postsStore.error" :message="postsStore.error" />
    <div v-else-if="postsStore.posts.length === 0" class="mt-4">
      <p class="text-gray-500">No posts yet. Generate some from the Generate page.</p>
    </div>
    <div v-else class="mt-4 space-y-2">
      <PostCard v-for="post in postsStore.posts" :key="post.id" :post="post" :truncate="100" />
    </div>
  </div>
</template>
