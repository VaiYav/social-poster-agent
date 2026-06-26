<script setup lang="ts">
withDefaults(defineProps<{
  message?: string;
}>(), {
  message: 'Something went wrong.',
});
</script>

<template>
  <div class="flex flex-col items-center justify-center py-8 text-center">
    <div class="text-4xl text-red-300 mb-2">⚠️</div>
    <p class="text-sm text-red-600">{{ message }}</p>
  </div>
</template>
