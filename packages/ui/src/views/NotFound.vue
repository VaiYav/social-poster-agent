<script setup lang="ts">
import { ArrowLeft } from '@lucide/vue';
</script>

<template>
  <div class="flex min-h-[60vh] flex-col items-center justify-center text-center">
    <div class="relative">
      <div class="absolute inset-0 flex items-center justify-center">
        <div class="h-32 w-32 rounded-full bg-primary/10 blur-3xl" />
      </div>
      <h1 class="relative text-8xl font-bold gradient-text">404</h1>
    </div>

    <p class="mt-4 text-2xl font-semibold text-text-primary">Page not found</p>
    <p class="mt-2 max-w-md text-text-secondary">
      The page you're looking for doesn't exist or has been moved to another dimension.
    </p>

    <router-link
      to="/"
      class="mt-8 inline-flex items-center gap-2 rounded-lg bg-primary px-5 py-2.5 text-sm font-medium text-white shadow-glow transition-all hover:bg-primary-hover hover:shadow-glow-primary"
    >
      <ArrowLeft class="h-4 w-4" />
      Back to Dashboard
    </router-link>
  </div>
</template>
