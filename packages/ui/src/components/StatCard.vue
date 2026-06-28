<script setup lang="ts">
import type { Component } from 'vue';
import { Card } from './ui';

const props = defineProps<{
  label: string;
  value: number | string;
  icon?: Component;
  color?: string;
  trend?: string;
  trendUp?: boolean;
}>();
</script>

<template>
  <Card hoverable class="p-5">
    <div class="flex items-start justify-between">
      <div>
        <p class="text-sm font-medium text-text-secondary">{{ label }}</p>
        <p class="mt-2 text-3xl font-bold tracking-tight" :class="color ?? 'text-text-primary'">{{ value }}</p>
      </div>
      <div v-if="icon" class="flex h-10 w-10 items-center justify-center rounded-lg bg-primary-subtle text-primary">
        <component :is="icon" class="h-5 w-5" />
      </div>
    </div>
    <div v-if="trend" class="mt-4 flex items-center gap-1.5 text-xs">
      <span
        :class="trendUp === undefined ? 'text-text-muted' : trendUp ? 'text-success' : 'text-error'"
      >
        {{ trendUp === undefined ? '' : trendUp ? '↑' : '↓' }} {{ trend }}
      </span>
    </div>
  </Card>
</template>
