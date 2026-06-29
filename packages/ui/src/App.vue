<script setup lang="ts">
import { ref, watch, computed } from 'vue';
import { RouterView, useRoute, useRouter } from 'vue-router';
import { Menu, LogOut } from '@lucide/vue';
import { usePostsStore } from './stores/posts';
import { useMonitoringStore } from './stores/monitoring';
import { useAuthStore } from './stores/auth';
import { useToast } from './composables/useToast';
import { useSSE } from './composables/useSSE';
import { useKeyboardShortcuts } from './composables/useKeyboardShortcuts';
import { Sidebar, StatusDot } from './components/ui';
import ToastContainer from './components/ToastContainer.vue';

/**
 * B6: Global SSE connection — listens for real-time post status updates
 * and dispatches events to the appropriate Pinia stores.
 * Toast notifications on POSTED/FAILED/health_alert events.
 *
 * Uses useSSE composable with exponential backoff reconnection (P0-H4).
 */
const postsStore = usePostsStore();
const monitoringStore = useMonitoringStore();
const authStore = useAuthStore();
const toast = useToast();
const route = useRoute();
const router = useRouter();
const mobileMenuOpen = ref(false);

// Auth: hide sidebar + header on login page (standalone layout)
const isLoginPage = computed(() => route.name === 'login');

// Global keyboard shortcuts (Ctrl+K=queue, Ctrl+G=generate, etc.)
useKeyboardShortcuts();

const apiBase = import.meta.env.VITE_API_URL ?? '/api/v1';
const sseUrl = `${apiBase}/events/sse`;
const { data: sseData, isConnected: sseConnected, error: sseError } = useSSE(sseUrl, {
  maxRetries: 50,
  baseDelayMs: 1000,
  maxDelayMs: 30000,
});

// Sync connection state to stores
watch(sseConnected, (connected) => {
  postsStore.setSseConnected(connected);
});

// Show toast on SSE connection errors
watch(sseError, (err) => {
  if (err) toast.error(`SSE: ${err}`);
});

// Dispatch SSE events to stores + toasts
watch(sseData, (data) => {
  if (!data || typeof data !== 'object') return;
  const evt = data as { type: string; postId?: string; status?: string; network?: string; error?: string; repliesPosted?: number; humanReview?: number };
  postsStore.handleSseEvent(evt);
  monitoringStore.handleSseEvent(evt);

  if (evt.type === 'post_status') {
    if (evt.status === 'POSTED') {
      toast.success(`Post ${evt.postId?.slice(0, 8)}… posted on ${evt.network}`);
    } else if (evt.status === 'FAILED') {
      toast.error(`Post ${evt.postId?.slice(0, 8)}… failed on ${evt.network}: ${evt.error ?? 'unknown error'}`);
    }
  } else if (evt.type === 'health_alert') {
    toast.warning(`Health alert: ${evt.error ?? 'session issue detected'}`);
  } else if (evt.type === 'reply_posted') {
    toast.success(`Reply posted on ${evt.network}`);
  } else if (evt.type === 'replies_monitor') {
    toast.info(`Replies cycle: ${evt.repliesPosted ?? 0} posted, ${evt.humanReview ?? 0} need review`);
  }
});

// Auth: logout handler
async function handleLogout() {
  await authStore.logout();
  router.push({ name: 'login' });
}
</script>

<template>
  <!-- Login page: standalone, no sidebar/header -->
  <div v-if="isLoginPage">
    <RouterView />
    <ToastContainer />
  </div>

  <!-- Authenticated layout: sidebar + header + main -->
  <div v-else class="flex min-h-screen bg-background">
    <Sidebar v-model:mobile-open="mobileMenuOpen">
      <template #footer>
        <div class="space-y-3">
          <!-- SSE connection status -->
          <div class="flex items-center justify-between rounded-lg border border-border bg-surface-elevated px-3 py-2">
            <span class="text-xs text-text-muted">SSE</span>
            <StatusDot
              :state="sseConnected ? 'connected' : 'disconnected'"
              :pulse="sseConnected"
            />
          </div>
          <!-- Admin user + logout -->
          <div class="flex items-center justify-between rounded-lg border border-border bg-surface-elevated px-3 py-2">
            <div class="flex items-center gap-2 min-w-0">
              <div class="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-primary/20 text-xs font-bold text-primary">
                {{ authStore.user?.username?.charAt(0).toUpperCase() ?? '?' }}
              </div>
              <span class="truncate text-xs font-medium text-text-secondary">
                {{ authStore.user?.username ?? 'unknown' }}
              </span>
            </div>
            <button
              class="shrink-0 rounded-md p-1.5 text-text-muted hover:bg-surface-highlight hover:text-error"
              title="Sign out"
              @click="handleLogout"
            >
              <LogOut class="h-4 w-4" />
            </button>
          </div>
        </div>
      </template>
    </Sidebar>

    <!-- Mobile overlay -->
    <div
      v-if="mobileMenuOpen"
      class="fixed inset-0 z-30 bg-black/60 backdrop-blur-sm lg:hidden"
      @click="mobileMenuOpen = false"
    />

    <div class="flex flex-1 flex-col overflow-hidden">
      <header class="flex h-16 items-center justify-between border-b border-border px-4 lg:px-8">
        <div class="flex items-center gap-3">
          <button
            class="lg:hidden rounded-lg p-2 text-text-secondary hover:bg-surface-elevated"
            @click="mobileMenuOpen = true"
          >
            <Menu class="h-5 w-5" />
          </button>
          <h2 class="text-sm font-medium text-text-secondary">
            Social Poster Agent for My Zodiac AI
          </h2>
        </div>
        <div class="flex items-center gap-4">
          <span class="text-xs text-text-muted">v0.5.2</span>
        </div>
      </header>

      <main class="flex-1 overflow-y-auto p-4 lg:p-8">
        <RouterView />
      </main>
    </div>

    <ToastContainer />
  </div>
</template>
