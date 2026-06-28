<script setup lang="ts">
import { Loader2 } from '@lucide/vue';

withDefaults(defineProps<{
  message?: string;
}>(), {
  message: 'Loading...',
});
</script>

<template>
  <div class="flex items-center justify-center py-10">
    <div class="flex items-center gap-3 text-text-secondary">
      <Loader2 class="h-5 w-5 animate-spin" />
      <span class="text-sm">{{ message }}</span>
    </div>
  </div>
</template>
