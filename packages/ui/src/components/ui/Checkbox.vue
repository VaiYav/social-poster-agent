<script setup lang="ts">
import { Check } from '@lucide/vue';
import { cn } from '../../lib/utils';

const props = defineProps<{
  modelValue?: boolean;
  disabled?: boolean;
  class?: string;
}>();

const emit = defineEmits<{
  'update:modelValue': [value: boolean];
}>();

function toggle() {
  if (!props.disabled) {
    emit('update:modelValue', !props.modelValue);
  }
}
</script>

<template>
  <button
    type="button"
    role="checkbox"
    :aria-checked="modelValue"
    :disabled="disabled"
    :class="cn(
      'flex h-5 w-5 items-center justify-center rounded border transition-all duration-200',
      modelValue
        ? 'border-primary bg-primary text-text-primary'
        : 'border-border bg-surface-elevated text-transparent hover:border-border-strong',
      disabled && 'cursor-not-allowed opacity-50',
      props.class,
    )"
    @click="toggle"
  >
    <Check class="h-3.5 w-3.5" />
  </button>
</template>
