<script setup lang="ts">
const props = defineProps<{
  network: string;
}>();

const icons: Record<string, string> = {
  X: '𝕏',
  THREADS: '🧵',
  FACEBOOK: '📘',
};

const labels: Record<string, string> = {
  X: 'X.com',
  THREADS: 'Threads',
  FACEBOOK: 'Facebook',
};

const icon = icons[props.network] ?? '?';
const label = labels[props.network] ?? props.network;
</script>

<template>
  <span class="flex items-center gap-1 text-xs font-medium text-gray-600">
    <span>{{ icon }}</span>
    <span>{{ label }}</span>
  </span>
</template>
