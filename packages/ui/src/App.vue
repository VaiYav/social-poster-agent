<script setup lang="ts">
import { onMounted, onUnmounted, ref } from 'vue';
import { RouterView, RouterLink } from 'vue-router';
import { usePostsStore } from './stores/posts';
import { useToast } from './composables/useToast';
import ToastContainer from './components/ToastContainer.vue';

/**
 * B6: Global SSE connection — listens for real-time post status updates
 * and dispatches events to the appropriate Pinia stores.
 * Toast notifications on POSTED/FAILED/health_alert events.
 */
const postsStore = usePostsStore();
const toast = useToast();
const sseConnected = ref(false);
let eventSource: EventSource | null = null;

function connectSSE(): void {
  // In dev: Vite proxy forwards /api → http://localhost:3100
  // In prod: nginx proxies /api → backend container (with SSE no-buffering)
  const apiBase = import.meta.env.VITE_API_URL ?? '/api/v1';
  const sseUrl = `${apiBase}/events/sse`;
  eventSource = new EventSource(sseUrl);

  eventSource.onopen = () => {
    sseConnected.value = true;
    postsStore.setSseConnected(true);
  };

  eventSource.onerror = () => {
    sseConnected.value = false;
    postsStore.setSseConnected(false);
    // Auto-reconnect after 5 seconds
    eventSource?.close();
    setTimeout(() => connectSSE(), 5000);
  };

  eventSource.onmessage = (event) => {
    try {
      const data = JSON.parse(event.data) as { type: string; postId?: string; status?: string; network?: string; error?: string };
      postsStore.handleSseEvent(data);

      // Toast notifications for key events
      if (data.type === 'post_status') {
        if (data.status === 'POSTED') {
          toast.success(`Post ${data.postId?.slice(0, 8)}… posted on ${data.network}`);
        } else if (data.status === 'FAILED') {
          toast.error(`Post ${data.postId?.slice(0, 8)}… failed on ${data.network}: ${data.error ?? 'unknown error'}`);
        }
      } else if (data.type === 'health_alert') {
        toast.warning(`Health alert: ${data.error ?? 'session issue detected'}`);
      }
    } catch {
      // ignore malformed events
    }
  };
}

onMounted(() => {
  connectSSE();
});

onUnmounted(() => {
  eventSource?.close();
});
</script>

<template>
  <div class="min-h-screen bg-gray-50">
    <nav class="border-b border-gray-200 bg-white px-6 py-3">
      <div class="mx-auto flex max-w-6xl items-center gap-6">
        <RouterLink to="/" class="text-lg font-bold text-gray-900">SPA</RouterLink>
        <div class="flex gap-4">
          <RouterLink to="/" class="text-sm text-gray-600 hover:text-gray-900">Dashboard</RouterLink>
          <RouterLink to="/queue" class="text-sm text-gray-600 hover:text-gray-900">Queue</RouterLink>
          <RouterLink to="/history" class="text-sm text-gray-600 hover:text-gray-900">History</RouterLink>
          <RouterLink to="/generate" class="text-sm text-gray-600 hover:text-gray-900">Generate</RouterLink>
          <RouterLink to="/sessions" class="text-sm text-gray-600 hover:text-gray-900">Sessions</RouterLink>
        </div>
        <!-- B6: SSE connection indicator -->
        <div class="ml-auto flex items-center gap-2 text-xs">
          <span
            class="inline-block h-2 w-2 rounded-full"
            :class="sseConnected ? 'bg-green-500' : 'bg-red-400'"
          />
          <span class="text-gray-500">{{ sseConnected ? 'Live' : 'Disconnected' }}</span>
        </div>
      </div>
    </nav>
    <main class="mx-auto max-w-6xl px-6 py-8">
      <RouterView />
    </main>
    <ToastContainer />
  </div>
</template>
