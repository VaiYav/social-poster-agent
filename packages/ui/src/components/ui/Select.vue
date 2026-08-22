<script setup lang="ts">
import { cn } from "../../lib/utils";

interface SelectOption {
  value: string;
  label: string;
}

const props = defineProps<{
  modelValue?: string;
  options: SelectOption[];
  placeholder?: string;
  disabled?: boolean;
  class?: string;
}>();

const emit = defineEmits<{
  "update:modelValue": [value: string];
}>();

function onChange(event: Event) {
  emit("update:modelValue", (event.target as HTMLSelectElement).value);
}
</script>

<template>
  <select
    :value="modelValue"
    :disabled="disabled"
    :class="
      cn(
        'h-10 w-full rounded-md border border-border bg-surface-elevated px-3 text-sm text-text-primary',
        'focus:border-primary focus:ring-1 focus:ring-primary/50',
        'transition-colors duration-200',
        props.class,
      )
    "
    @change="onChange"
  >
    <option v-if="placeholder" value="" disabled selected>{{ placeholder }}</option>
    <option v-for="option in options" :key="option.value" :value="option.value">
      {{ option.label }}
    </option>
  </select>
</template>
