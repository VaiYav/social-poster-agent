<script setup lang="ts">
import { ref } from 'vue';
import { useRouter } from 'vue-router';
import { Sparkles } from '@lucide/vue';
import { useAuthStore } from '../stores/auth';
import { Button, Input } from '../components/ui';

const router = useRouter();
const authStore = useAuthStore();

const username = ref('');
const password = ref('');
const showPassword = ref(false);

async function handleLogin() {
  if (!username.value || !password.value) return;
  const success = await authStore.login(username.value, password.value);
  if (success) {
    router.push('/');
  }
}

function handleKeydown(event: KeyboardEvent) {
  if (event.key === 'Enter') {
    handleLogin();
  }
}
</script>

<template>
  <div class="flex min-h-screen items-center justify-center bg-background px-4">
    <div class="w-full max-w-md">
      <!-- Logo / header -->
      <div class="mb-8 text-center">
        <div class="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-xl bg-gradient-to-br from-primary to-secondary shadow-glow-primary">
          <Sparkles class="h-7 w-7 text-white" />
        </div>
        <h1 class="text-2xl font-bold text-text-primary">Social Poster Agent</h1>
        <p class="mt-1 text-sm text-text-muted">Sign in to the admin dashboard</p>
      </div>

      <!-- Login form -->
      <div class="rounded-xl border border-border bg-surface p-6 shadow-cosmic">
        <div class="space-y-4">
          <div>
            <label class="mb-1.5 block text-xs font-medium text-text-secondary">Username</label>
            <Input
              v-model="username"
              placeholder="admin"
              :disabled="authStore.loading"
              autocomplete="username"
              @keydown="handleKeydown"
            />
          </div>

          <div>
            <label class="mb-1.5 block text-xs font-medium text-text-secondary">Password</label>
            <Input
              v-model="password"
              :type="showPassword ? 'text' : 'password'"
              placeholder="••••••••"
              :disabled="authStore.loading"
              autocomplete="current-password"
              @keydown="handleKeydown"
            />
          </div>

          <div class="flex items-center gap-2">
            <input
              id="show-password"
              v-model="showPassword"
              type="checkbox"
              class="h-4 w-4 rounded border-border accent-primary"
            />
            <label for="show-password" class="text-xs text-text-muted">Show password</label>
          </div>

          <!-- Error message -->
          <p v-if="authStore.error" class="rounded-md border border-error/30 bg-error/10 px-3 py-2 text-xs text-error">
            {{ authStore.error }}
          </p>

          <Button
            type="submit"
            :loading="authStore.loading"
            :disabled="!username || !password"
            class="w-full"
            size="lg"
            @click="handleLogin"
          >
            Sign in
          </Button>
        </div>
      </div>

      <p class="mt-6 text-center text-xs text-text-muted">
        Admin account is configured via ADMIN_USERNAME / ADMIN_PASSWORD env vars.
      </p>
    </div>
  </div>
</template>
