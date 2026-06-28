<script setup lang="ts">
import type { Component } from 'vue';
import { CheckCircle2, XCircle, AlertTriangle, Info, X } from '@lucide/vue';
import { useToast } from '../composables/useToast';

const { toasts, dismiss } = useToast();

const typeStyles: Record<string, string> = {
  success: 'bg-success-subtle border-success/30 text-success',
  error: 'bg-error-subtle border-error/30 text-error',
  info: 'bg-info-subtle border-info/30 text-info',
  warning: 'bg-warning-subtle border-warning/30 text-warning',
};

const typeIcons: Record<string, Component> = {
  success: CheckCircle2,
  error: XCircle,
  info: Info,
  warning: AlertTriangle,
};
</script>

<template>
  <div class="fixed bottom-4 right-4 z-50 flex flex-col gap-2">
    <TransitionGroup name="toast">
      <div
        v-for="toast in toasts"
        :key="toast.id"
        class="flex min-w-[320px] max-w-md items-start gap-3 rounded-lg border p-4 shadow-elevated"
        :class="typeStyles[toast.type]"
      >
        <component :is="typeIcons[toast.type]" class="mt-0.5 h-5 w-5 shrink-0" />
        <span class="flex-1 text-sm font-medium">{{ toast.message }}</span>
        <button
          @click="dismiss(toast.id)"
          class="shrink-0 opacity-70 transition-opacity hover:opacity-100"
        >
          <X class="h-4 w-4" />
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
