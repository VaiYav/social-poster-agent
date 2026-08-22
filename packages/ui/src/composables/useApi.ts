import axios from "axios";

// In dev: Vite proxy forwards /api → http://localhost:3100
// In prod: nginx proxies /api → backend container
// VITE_API_URL can override for direct backend connection
const api = axios.create({
  baseURL: import.meta.env.VITE_API_URL ?? "/api/v1",
  timeout: 30000, // Sprint N: 30s timeout
  headers: {
    "Content-Type": "application/json",
  },
  withCredentials: true, // Auth: send httpOnly JWT cookie with every request
});

// Sprint N: Request interceptor — add correlation ID for tracing
api.interceptors.request.use((config) => {
  config.headers["X-Correlation-Id"] = `ui-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  return config;
});

// Sprint N: Response interceptor — normalize errors for UI
// Auth: on 401, clear auth state and redirect to /login
api.interceptors.response.use(
  (response) => response,
  (error) => {
    if (error.code === "ECONNABORTED") {
      error.message = "Request timeout. Please retry.";
    } else if (!error.response) {
      error.message = "Network error. Check backend is running.";
    } else if (error.response?.status === 401) {
      // Auth: token missing/expired — redirect to login.
      // Avoid circular import: dynamically import the store + router.
      // Only redirect if we're not already on /login (avoid loop on bad login attempt).
      if (!window.location.pathname.startsWith("/login")) {
        import("../stores/auth").then(({ useAuthStore }) => {
          const authStore = useAuthStore();
          authStore.clearAuth();
        });
        import("../router").then(({ default: router }) => {
          router.push({ name: "login", query: { redirect: window.location.pathname } });
        });
      }
      error.message = "Session expired. Please sign in again.";
    } else if (error.response?.status === 404) {
      error.message = "Resource not found.";
    } else if (error.response?.status >= 500) {
      error.message = "Server error. Please try again later.";
    }
    return Promise.reject(error);
  },
);

export function useApi() {
  return api;
}

export default api;
