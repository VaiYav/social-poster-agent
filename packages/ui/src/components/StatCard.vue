<script setup lang="ts">
defineProps<{
  label: string;
  value: number | string;
  color?: string;
}>();
</script>

<template>
  <div class="rounded-lg border border-gray-200 bg-white p-4">
    <div class="text-sm text-gray-500">{{ label }}</div>
    <div class="text-2xl font-bold" :class="color ?? 'text-gray-900'">{{ value }}</div>
  </div>
</template>
