<script setup lang="ts">
import Badge from './ui/Badge.vue';

const props = defineProps<{
  status: string;
}>();

const variantMap: Record<string, 'default' | 'success' | 'warning' | 'error' | 'info' | 'neutral'> = {
  DRAFT: 'neutral',
  APPROVED: 'info',
  POSTING: 'warning',
  POSTED: 'success',
  FAILED: 'error',
  REJECTED: 'neutral',
};

const variant = variantMap[props.status] ?? 'neutral';
</script>

<template>
  <Badge :variant="variant">
    <template #dot>
      <span />
    </template>
    {{ status }}
  </Badge>
</template>
