<script setup lang="ts">
import { cn } from "../../lib/utils";

type BadgeVariant =
  | "default"
  | "primary"
  | "secondary"
  | "success"
  | "warning"
  | "error"
  | "info"
  | "neutral";

const props = withDefaults(
  defineProps<{
    variant?: BadgeVariant;
    class?: string;
  }>(),
  {
    variant: "default",
  },
);

const variantStyles: Record<BadgeVariant, string> = {
  default: "bg-primary-subtle text-primary border-primary/20",
  primary: "bg-primary-subtle text-primary border-primary/20",
  secondary: "bg-secondary-subtle text-secondary border-secondary/20",
  success: "bg-success-subtle text-success border-success/20",
  warning: "bg-warning-subtle text-warning border-warning/20",
  error: "bg-error-subtle text-error border-error/20",
  info: "bg-info-subtle text-info border-info/20",
  neutral: "bg-surface-highlight text-text-secondary border-border",
};
</script>

<template>
  <span
    :class="
      cn(
        'inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-medium',
        variantStyles[variant],
        props.class,
      )
    "
  >
    <span
      v-if="$slots.dot"
      class="h-1.5 w-1.5 rounded-full"
      :class="{
        'bg-primary': variant === 'default' || variant === 'primary',
        'bg-secondary': variant === 'secondary',
        'bg-success': variant === 'success',
        'bg-warning': variant === 'warning',
        'bg-error': variant === 'error',
        'bg-info': variant === 'info',
        'bg-text-secondary': variant === 'neutral',
      }"
    />
    <slot />
  </span>
</template>
