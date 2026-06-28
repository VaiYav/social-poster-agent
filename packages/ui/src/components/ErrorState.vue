<script setup lang="ts">
import { AlertCircle } from '@lucide/vue';

withDefaults(defineProps<{
  message?: string;
}>(), {
  message: 'Something went wrong.',
});
</script>

<template>
  <div class="flex flex-col items-center justify-center py-10 text-center">
    <div class="mb-3 flex h-12 w-12 items-center justify-center rounded-full bg-error-subtle">
      <AlertCircle class="h-6 w-6 text-error" />
    </div>
    <p class="max-w-md text-sm text-error">{{ message }}</p>
  </div>
</template>
