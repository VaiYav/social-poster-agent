<script setup lang="ts">
import { Loader2 } from "@lucide/vue";
import { cn } from "../../lib/utils";

type ButtonVariant = "primary" | "secondary" | "outline" | "ghost" | "destructive";
type ButtonSize = "sm" | "md" | "lg";

const props = withDefaults(
  defineProps<{
    variant?: ButtonVariant;
    size?: ButtonSize;
    loading?: boolean;
    disabled?: boolean;
    type?: "button" | "submit" | "reset";
    class?: string;
  }>(),
  {
    variant: "primary",
    size: "md",
    loading: false,
    disabled: false,
    type: "button",
  },
);

const emit = defineEmits<{
  click: [event: MouseEvent];
}>();

const variantStyles: Record<ButtonVariant, string> = {
  primary:
    "bg-primary text-text-primary hover:bg-primary-hover shadow-cosmic hover:shadow-glow-primary",
  secondary:
    "bg-secondary text-text-primary hover:bg-secondary-hover shadow-cosmic hover:shadow-glow-secondary",
  outline:
    "border border-border-strong bg-transparent text-text-primary hover:bg-surface-highlight hover:border-border",
  ghost: "bg-transparent text-text-secondary hover:text-text-primary hover:bg-surface-highlight",
  destructive: "bg-error text-text-primary hover:bg-error/90 shadow-cosmic hover:shadow-glow-error",
};

const sizeStyles: Record<ButtonSize, string> = {
  sm: "h-8 px-3 text-xs",
  md: "h-10 px-4 text-sm",
  lg: "h-12 px-6 text-base",
};

function handleClick(event: MouseEvent) {
  if (!props.loading && !props.disabled) {
    emit("click", event);
  }
}
</script>

<template>
  <button
    :type="type"
    :disabled="disabled || loading"
    :class="cn('btn-base', variantStyles[variant], sizeStyles[size], props.class)"
    @click="handleClick"
  >
    <Loader2 v-if="loading" class="h-4 w-4 animate-spin" aria-hidden="true" />
    <slot name="icon" />
    <slot />
  </button>
</template>
