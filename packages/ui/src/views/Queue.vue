<script setup lang="ts">
import { ref, onMounted } from 'vue';
import type { Post } from '@spa/shared';
import { usePostsStore } from '../stores/posts';
import { useToast } from '../composables/useToast';
import PostCard from '../components/PostCard.vue';
import PostEditor from '../components/PostEditor.vue';
import LoadingSpinner from '../components/LoadingSpinner.vue';
import ErrorState from '../components/ErrorState.vue';
import EmptyState from '../components/EmptyState.vue';

const postsStore = usePostsStore();
const toast = useToast();
const editingPost = ref<Post | null>(null);

onMounted(() => postsStore.fetchDrafts());

async function approve(id: string) {
  try {
    await postsStore.approve(id);
    toast.success('Post approved — added to posting queue');
  } catch (e: unknown) {
    toast.error(`Approve failed: ${(e as Error).message}`);
  }
}

async function reject(id: string) {
  try {
    await postsStore.reject(id);
    toast.info('Post rejected');
  } catch (e: unknown) {
    toast.error(`Reject failed: ${(e as Error).message}`);
  }
}

function edit(post: Post) {
  editingPost.value = post;
}

async function saveEdit(id: string, editedContent: string) {
  try {
    await postsStore.approve(id, editedContent);
    editingPost.value = null;
    toast.success('Post edited and approved');
  } catch (e: unknown) {
    toast.error(`Edit & approve failed: ${(e as Error).message}`);
  }
}

function closeEditor() {
  editingPost.value = null;
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
        @edit="edit"
        @reject="reject"
      />
    </div>

    <PostEditor
      :post="editingPost"
      @close="closeEditor"
      @save="saveEdit"
    />
  </div>
</template>
