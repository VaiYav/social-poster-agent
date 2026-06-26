import { defineStore } from 'pinia';
import { ref, computed } from 'vue';
import api from '../composables/useApi';
import type { Post } from '@spa/shared';

/**
 * Posts store — manages post list, drafts, and CRUD operations.
 * Used by Dashboard, Queue, History views.
 *
 * B6: SSE integration — real-time post status updates via useSSE.
 * When a post_status event arrives, the post is updated in-place
 * without needing a full refetch.
 */
export const usePostsStore = defineStore('posts', () => {
  const posts = ref<Post[]>([]);
  const drafts = ref<Post[]>([]);
  const total = ref(0);
  const loading = ref(false);
  const error = ref<string | null>(null);
  const sseConnected = ref(false);
  const lastSseEvent = ref<{ type: string; postId?: string; status?: string; network?: string; error?: string } | null>(null);

  const draftCount = computed(() => drafts.value.length);

  async function fetchPosts(params?: { status?: string; network?: string; limit?: number; offset?: number }) {
    loading.value = true;
    error.value = null;
    try {
      const res = await api.get('/posts', { params });
      const data = res.data;
      posts.value = Array.isArray(data) ? data : (data.posts ?? []);
      total.value = Array.isArray(data) ? data.length : (data.total ?? 0);
    } catch (e: unknown) {
      error.value = (e as Error).message;
    } finally {
      loading.value = false;
    }
  }

  async function fetchDrafts(network?: string) {
    loading.value = true;
    error.value = null;
    try {
      const res = await api.get('/posts/drafts', { params: { network } });
      const data = res.data;
      drafts.value = Array.isArray(data) ? data : (data.posts ?? []);
    } catch (e: unknown) {
      error.value = (e as Error).message;
    } finally {
      loading.value = false;
    }
  }

  async function approve(id: string, editedContent?: string) {
    await api.post(`/posts/${id}/approve`, editedContent ? { editedContent } : {});
    const post = drafts.value.find((p) => p.id === id);
    if (post) {
      post.status = 'APPROVED';
      if (editedContent) post.content = editedContent;
    }
    drafts.value = drafts.value.filter((p) => p.id !== id);
  }

  async function reject(id: string) {
    await api.post(`/posts/${id}/reject`);
    drafts.value = drafts.value.filter((p) => p.id !== id);
  }

  async function postById(id: string) {
    return api.post(`/posting/${id}`);
  }

  async function postAllApproved() {
    return api.post('/posting/batch/all-approved');
  }

  /**
   * B6: Handle SSE event — update post status in real-time.
   * Called by useSSE composable when a post_status event arrives.
   */
  function handleSseEvent(event: { type: string; postId?: string; status?: string; network?: string; error?: string }) {
    lastSseEvent.value = event;

    if (event.type === 'post_status' && event.postId) {
      // Update post in posts list
      const post = posts.value.find((p) => p.id === event.postId);
      if (post && event.status) {
        post.status = event.status as Post['status'];
      }

      // If post transitioned to POSTED or FAILED, could trigger refetch
      // or notification. For now, just update in-place.
      if (event.status === 'POSTED' || event.status === 'FAILED') {
        // Could add toast notification here
      }
    }

    if (event.type === 'health_alert') {
      // Health monitor alert — could show in notification bar
      // For now, just store as last event
    }
  }

  /**
   * B6: Set SSE connection status.
   */
  function setSseConnected(connected: boolean) {
    sseConnected.value = connected;
  }

  return {
    posts, drafts, total, loading, error, draftCount,
    sseConnected, lastSseEvent,
    fetchPosts, fetchDrafts, approve, reject, postById, postAllApproved,
    handleSseEvent, setSseConnected,
  };
});
