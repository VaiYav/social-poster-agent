<script setup lang="ts">
import { ref, onMounted, watch } from 'vue';
import { usePostsStore } from '../stores/posts';
import PostCard from '../components/PostCard.vue';
import LoadingSpinner from '../components/LoadingSpinner.vue';
import ErrorState from '../components/ErrorState.vue';
import EmptyState from '../components/EmptyState.vue';

const postsStore = usePostsStore();
const filter = ref<'POSTED' | 'FAILED' | 'REJECTED'>('POSTED');

async function loadPosts() {
  await postsStore.fetchPosts({ status: filter.value, limit: 50 });
}

onMounted(loadPosts);
watch(filter, loadPosts);
</script>

<template>
  <div>
    <h1 class="text-2xl font-bold text-gray-900">History</h1>
    <div class="mt-4 flex gap-2">
      <button @click="filter = 'POSTED'" class="rounded px-3 py-1 text-sm" :class="filter === 'POSTED' ? 'bg-gray-900 text-white' : 'bg-gray-100'">Posted</button>
      <button @click="filter = 'FAILED'" class="rounded px-3 py-1 text-sm" :class="filter === 'FAILED' ? 'bg-gray-900 text-white' : 'bg-gray-100'">Failed</button>
      <button @click="filter = 'REJECTED'" class="rounded px-3 py-1 text-sm" :class="filter === 'REJECTED' ? 'bg-gray-900 text-white' : 'bg-gray-100'">Rejected</button>
    </div>

    <LoadingSpinner v-if="postsStore.loading" />
    <ErrorState v-else-if="postsStore.error" :message="postsStore.error" />
    <EmptyState v-else-if="postsStore.posts.length === 0" :message="`No ${filter.toLowerCase()} posts found.`" />
    <div v-else class="mt-6 space-y-2">
      <PostCard v-for="post in postsStore.posts" :key="post.id" :post="post" :truncate="120" />
    </div>
  </div>
</template>
