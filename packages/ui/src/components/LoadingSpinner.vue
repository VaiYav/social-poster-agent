<script setup lang="ts">
withDefaults(defineProps<{
  message?: string;
}>(), {
  message: 'Loading...',
});
</script>

<template>
  <div class="flex items-center justify-center py-8">
    <div class="flex items-center gap-3 text-gray-500">
      <svg class="h-5 w-5 animate-spin" viewBox="0 0 24 24" fill="none">
        <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4" />
        <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
      </svg>
      <span class="text-sm">{{ message }}</span>
    </div>
  </div>
</template>
