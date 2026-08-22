<script setup lang="ts">
import { computed } from "vue";
import { cn } from "../../lib/utils";

type ProgressColor = "primary" | "success" | "warning" | "error" | "info";

const props = withDefaults(
  defineProps<{
    value: number;
    max?: number;
    size?: "sm" | "md" | "lg";
    color?: ProgressColor;
    showLabel?: boolean;
    class?: string;
  }>(),
  {
    max: 100,
    size: "md",
    color: "primary",
    showLabel: true,
  },
);

const percentage = computed(() => {
  const pct = (props.value / props.max) * 100;
  return Math.min(100, Math.max(0, pct));
});

const colorStyles: Record<ProgressColor, string> = {
  primary: "bg-gradient-to-r from-primary to-secondary",
  success: "bg-success",
  warning: "bg-warning",
  error: "bg-error",
  info: "bg-info",
};

const sizeStyles = {
  sm: "h-1.5",
  md: "h-2",
  lg: "h-3",
};
</script>

<template>
  <div :class="cn('w-full', props.class)">
    <div class="mb-1 flex items-center justify-between" v-if="showLabel">
      <span class="text-sm text-text-secondary">
        <slot />
      </span>
      <span class="text-sm font-medium text-text-primary">{{ Math.round(percentage) }}%</span>
    </div>
    <div class="w-full overflow-hidden rounded-full bg-surface-highlight" :class="sizeStyles[size]">
      <div
        class="h-full rounded-full transition-all duration-500 ease-out"
        :class="colorStyles[color]"
        :style="{ width: `${percentage}%` }"
      />
    </div>
  </div>
</template>
