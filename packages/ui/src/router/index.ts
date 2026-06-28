import { createRouter, createWebHistory } from 'vue-router';

const router = createRouter({
  history: createWebHistory(),
  routes: [
    {
      path: '/',
      name: 'dashboard',
      component: () => import('../views/Dashboard.vue'),
    },
    {
      path: '/monitor',
      name: 'monitor',
      component: () => import('../views/Monitor.vue'),
    },
    {
      path: '/queue',
      name: 'queue',
      component: () => import('../views/Queue.vue'),
    },
    {
      path: '/history',
      name: 'history',
      component: () => import('../views/History.vue'),
    },
    {
      path: '/generate',
      name: 'generate',
      component: () => import('../views/Generate.vue'),
    },
    {
      path: '/sessions',
      name: 'sessions',
      component: () => import('../views/Sessions.vue'),
    },
    {
      path: '/analytics',
      name: 'analytics',
      component: () => import('../views/Analytics.vue'),
    },
    {
      path: '/trending',
      name: 'trending',
      component: () => import('../views/Trending.vue'),
    },
    {
      path: '/quote-cards',
      name: 'quote-cards',
      component: () => import('../views/QuoteCards.vue'),
    },
    {
      path: '/flow-control',
      name: 'flow-control',
      component: () => import('../views/FlowControl.vue'),
    },
    {
      path: '/reports',
      name: 'reports',
      component: () => import('../views/Reports.vue'),
    },
    // Sprint N: 404 catch-all route
    {
      path: '/:pathMatch(.*)*',
      name: 'NotFound',
      component: () => import('../views/NotFound.vue'),
    },
  ],
});

export default router;
