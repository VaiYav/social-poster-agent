<script setup lang="ts">
import { Inbox } from '@lucide/vue';

withDefaults(defineProps<{
  message?: string;
}>(), {
  message: 'No data found.',
});
</script>

<template>
  <div class="flex flex-col items-center justify-center py-12 text-center">
    <div class="mb-3 flex h-12 w-12 items-center justify-center rounded-full bg-surface-highlight">
      <Inbox class="h-6 w-6 text-text-muted" />
    </div>
    <p class="max-w-md text-sm text-text-secondary">{{ message }}</p>
  </div>
</template>
