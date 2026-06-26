<script setup lang="ts">
withDefaults(defineProps<{
  message?: string;
}>(), {
  message: 'No data found.',
});
</script>

<template>
  <div class="flex flex-col items-center justify-center py-12 text-center">
    <div class="text-4xl text-gray-300 mb-2">📭</div>
    <p class="text-sm text-gray-500">{{ message }}</p>
  </div>
</template>
