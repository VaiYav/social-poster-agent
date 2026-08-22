import { createRouter, createWebHistory } from "vue-router";
import { useAuthStore } from "../stores/auth";

const router = createRouter({
  history: createWebHistory(),
  routes: [
    {
      path: "/login",
      name: "login",
      component: () => import("../views/Login.vue"),
      meta: { public: true },
    },
    {
      path: "/",
      name: "dashboard",
      component: () => import("../views/Dashboard.vue"),
    },
    {
      path: "/monitor",
      name: "monitor",
      component: () => import("../views/Monitor.vue"),
    },
    {
      path: "/queue",
      name: "queue",
      component: () => import("../views/Queue.vue"),
    },
    {
      path: "/history",
      name: "history",
      component: () => import("../views/History.vue"),
    },
    {
      path: "/generate",
      name: "generate",
      component: () => import("../views/Generate.vue"),
    },
    {
      path: "/sessions",
      name: "sessions",
      component: () => import("../views/Sessions.vue"),
    },
    {
      path: "/analytics",
      name: "analytics",
      component: () => import("../views/Analytics.vue"),
    },
    {
      path: "/trending",
      name: "trending",
      component: () => import("../views/Trending.vue"),
    },
    {
      path: "/quote-cards",
      name: "quote-cards",
      component: () => import("../views/QuoteCards.vue"),
    },
    {
      path: "/recycling",
      name: "recycling",
      component: () => import("../views/Recycling.vue"),
    },
    {
      path: "/calendar",
      name: "calendar",
      component: () => import("../views/Calendar.vue"),
    },
    {
      path: "/flow-control",
      name: "flow-control",
      component: () => import("../views/FlowControl.vue"),
    },
    {
      path: "/reports",
      name: "reports",
      component: () => import("../views/Reports.vue"),
    },
    {
      path: "/replies",
      name: "replies",
      component: () => import("../views/Replies.vue"),
    },
    {
      path: "/autonomous-agent",
      name: "autonomous-agent",
      component: () => import("../views/AutonomousAgent.vue"),
    },
    // Sprint N: 404 catch-all route
    {
      path: "/:pathMatch(.*)*",
      name: "NotFound",
      component: () => import("../views/NotFound.vue"),
    },
  ],
});

/**
 * Auth navigation guard — protects all routes except those with meta.public.
 * Checks the Pinia auth store's `isAuthenticated` flag. If not authenticated,
 * redirects to /login with a redirect query param.
 *
 * The auth store is initialized in App.vue (fetchMe on mount), so by the time
 * the first navigation runs, the store may still be loading. We handle this by
 * awaiting fetchMe if the auth state hasn't been determined yet.
 */
let authInitialized = false;

router.beforeEach(async (to) => {
  const authStore = useAuthStore();

  // On first navigation, try to restore the session from the httpOnly cookie.
  if (!authInitialized) {
    authInitialized = true;
    await authStore.fetchMe();
  }

  const isPublic = to.meta.public === true;

  // If route is public (e.g. /login) and user is authenticated → redirect to /
  if (isPublic && authStore.isAuthenticated) {
    return { name: "dashboard" };
  }

  // If route is not public and user is not authenticated → redirect to /login
  if (!isPublic && !authStore.isAuthenticated) {
    return { name: "login", query: { redirect: to.fullPath } };
  }

  return true;
});

export default router;
