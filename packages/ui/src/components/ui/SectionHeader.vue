<script setup lang="ts">
import { cn } from "../../lib/utils";

const props = defineProps<{
  title: string;
  description?: string;
  class?: string;
}>();
</script>

<template>
  <div :class="cn('mb-6', props.class)">
    <h1 class="text-2xl font-bold tracking-tight text-text-primary">
      {{ title }}
    </h1>
    <p v-if="description" class="mt-1 text-sm text-text-secondary">
      {{ description }}
    </p>
  </div>
</template>
