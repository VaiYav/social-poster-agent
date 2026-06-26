<script setup lang="ts">
const props = defineProps<{
  status: string;
}>();

const colors: Record<string, string> = {
  DRAFT: 'bg-yellow-100 text-yellow-700',
  APPROVED: 'bg-blue-100 text-blue-700',
  POSTING: 'bg-purple-100 text-purple-700',
  POSTED: 'bg-green-100 text-green-700',
  FAILED: 'bg-red-100 text-red-700',
  REJECTED: 'bg-gray-200 text-gray-600',
};

const cls = colors[props.status] ?? 'bg-gray-100 text-gray-500';
</script>

<template>
  <span class="rounded px-2 py-0.5 text-xs font-medium" :class="cls">{{ status }}</span>
</template>
