import { defineStore } from 'pinia';
import { ref } from 'vue';
import api from '../composables/useApi';
import type { AuthUser } from '@spa/shared';

/**
 * Auth store — JWT cookie-based authentication for the UI.
 *
 * The JWT is stored in an httpOnly cookie (set by the backend on POST /auth/login),
 * so the token is NOT accessible from JS — only the backend can read it. The store
 * only tracks the authenticated user object (id + username), obtained via GET /auth/me.
 *
 * On store init, `fetchMe()` is called to restore the session from the existing cookie
 * (if any). The router guard checks `isAuthenticated` to protect routes.
 */
export const useAuthStore = defineStore('auth', () => {
  const user = ref<AuthUser | null>(null);
  const loading = ref(false);
  const error = ref<string | null>(null);

  const isAuthenticated = ref(false);

  /**
   * Login: POST /auth/login with username/password.
   * Backend sets the httpOnly cookie; we store the returned user object.
   */
  async function login(username: string, password: string): Promise<boolean> {
    loading.value = true;
    error.value = null;
    try {
      const res = await api.post('/auth/login', { username, password });
      user.value = res.data.user;
      isAuthenticated.value = true;
      return true;
    } catch (e: unknown) {
      const err = e as { response?: { status?: number; data?: { message?: string } } };
      error.value = err.response?.data?.message ?? 'Login failed';
      isAuthenticated.value = false;
      return false;
    } finally {
      loading.value = false;
    }
  }

  /**
   * Logout: POST /auth/logout clears the cookie. Reset local state.
   */
  async function logout(): Promise<void> {
    try {
      await api.post('/auth/logout');
    } catch {
      // ignore — cookie may already be gone
    }
    user.value = null;
    isAuthenticated.value = false;
  }

  /**
   * Fetch current user from GET /auth/me — restores session from cookie.
   * Called on app init to check if the user is already authenticated.
   * Returns true if authenticated, false otherwise.
   */
  async function fetchMe(): Promise<boolean> {
    try {
      const res = await api.get('/auth/me');
      user.value = res.data.user;
      isAuthenticated.value = true;
      return true;
    } catch {
      user.value = null;
      isAuthenticated.value = false;
      return false;
    }
  }

  /**
   * Clear auth state locally (without calling logout endpoint).
   * Used by the 401 interceptor when the backend rejects the token.
   */
  function clearAuth(): void {
    user.value = null;
    isAuthenticated.value = false;
  }

  return {
    user,
    loading,
    error,
    isAuthenticated,
    login,
    logout,
    fetchMe,
    clearAuth,
  };
});
