<script setup lang="ts">
import { onMounted } from 'vue';
import { usePostsStore } from '../stores/posts';
import PostCard from '../components/PostCard.vue';
import LoadingSpinner from '../components/LoadingSpinner.vue';
import ErrorState from '../components/ErrorState.vue';
import EmptyState from '../components/EmptyState.vue';

const postsStore = usePostsStore();

onMounted(() => postsStore.fetchDrafts());

async function approve(id: string) {
  try {
    await postsStore.approve(id);
  } catch (e: unknown) {
    console.error('Approve failed:', e);
  }
}

async function reject(id: string) {
  try {
    await postsStore.reject(id);
  } catch (e: unknown) {
    console.error('Reject failed:', e);
  }
}
</script>

<template>
  <div>
    <h1 class="text-2xl font-bold text-gray-900">Queue — Draft Posts</h1>

    <LoadingSpinner v-if="postsStore.loading" />
    <ErrorState v-else-if="postsStore.error" :message="postsStore.error" />
    <EmptyState v-else-if="postsStore.drafts.length === 0" message="No drafts pending. Generate posts from the Generate page." />
    <div v-else class="mt-6 space-y-4">
      <PostCard
        v-for="post in postsStore.drafts"
        :key="post.id"
        :post="post"
        show-actions
        @approve="approve"
        @reject="reject"
      />
    </div>
  </div>
</template>
