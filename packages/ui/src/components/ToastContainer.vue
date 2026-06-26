<script setup lang="ts">
import { useToast } from '../composables/useToast';

const { toasts, dismiss } = useToast();

const typeStyles: Record<string, string> = {
  success: 'bg-green-600',
  error: 'bg-red-600',
  info: 'bg-blue-600',
  warning: 'bg-yellow-600',
};

const typeIcons: Record<string, string> = {
  success: '✓',
  error: '✕',
  info: 'i',
  warning: '!',
};
</script>

<template>
  <div class="fixed bottom-4 right-4 z-50 flex flex-col gap-2">
    <TransitionGroup name="toast">
      <div
        v-for="toast in toasts"
        :key="toast.id"
        class="flex items-center gap-3 rounded-lg px-4 py-3 text-sm text-white shadow-lg"
        :class="typeStyles[toast.type]"
      >
        <span class="flex h-5 w-5 items-center justify-center rounded-full bg-white/20 text-xs font-bold">
          {{ typeIcons[toast.type] }}
        </span>
        <span class="flex-1">{{ toast.message }}</span>
        <button @click="dismiss(toast.id)" class="text-white/70 hover:text-white">
          <svg class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      </div>
    </TransitionGroup>
  </div>
</template>

<style scoped>
.toast-enter-active,
.toast-leave-active {
  transition: all 0.3s ease;
}
.toast-enter-from {
  opacity: 0;
  transform: translateX(100px);
}
.toast-leave-to {
  opacity: 0;
  transform: translateX(100px);
}
</style>
