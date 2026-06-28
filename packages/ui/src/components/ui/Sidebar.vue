<script setup lang="ts">
import { RouterLink, useRoute } from 'vue-router';
import {
  LayoutDashboard,
  ListChecks,
  History,
  Sparkles,
  BarChart3,
  TrendingUp,
  ImageIcon,
  Globe,
  Activity,
  AlertTriangle,
  FileBarChart,
  X,
  type LucideIcon,
} from '@lucide/vue';
import { cn } from '../../lib/utils';

interface NavItem {
  label: string;
  to: string;
  icon: LucideIcon;
}

const route = useRoute();

const navItems: NavItem[] = [
  { label: 'Dashboard', to: '/', icon: LayoutDashboard },
  { label: 'Monitor', to: '/monitor', icon: Activity },
  { label: 'Queue', to: '/queue', icon: ListChecks },
  { label: 'History', to: '/history', icon: History },
  { label: 'Generate', to: '/generate', icon: Sparkles },
  { label: 'Analytics', to: '/analytics', icon: BarChart3 },
  { label: 'Trending', to: '/trending', icon: TrendingUp },
  { label: 'Quote Cards', to: '/quote-cards', icon: ImageIcon },
  { label: 'Sessions', to: '/sessions', icon: Globe },
  { label: 'Flow Control', to: '/flow-control', icon: AlertTriangle },
  { label: 'Reports', to: '/reports', icon: FileBarChart },
];

const props = defineProps<{
  class?: string;
  mobileOpen?: boolean;
}>();

const emit = defineEmits<{
  'update:mobileOpen': [value: boolean];
}>();

function closeMobile() {
  emit('update:mobileOpen', false);
}

function isActive(path: string): boolean {
  if (path === '/') {
    return route.path === '/';
  }
  return route.path.startsWith(path);
}
</script>

<template>
  <aside
    :class="cn(
      'fixed inset-y-0 left-0 z-40 flex w-64 flex-col border-r border-border bg-surface transition-transform duration-300 lg:static lg:translate-x-0',
      props.mobileOpen ? 'translate-x-0' : '-translate-x-full',
      props.class,
    )"
  >
    <div class="flex items-center justify-between px-6 py-5">
      <div class="flex items-center gap-3">
        <div class="flex h-9 w-9 items-center justify-center rounded-lg bg-gradient-to-br from-primary to-secondary">
          <Sparkles class="h-5 w-5 text-white" />
        </div>
        <div>
          <h1 class="text-lg font-bold text-text-primary">SPA</h1>
          <p class="text-xs text-text-muted">Cosmic Command</p>
        </div>
      </div>
      <button
        class="lg:hidden rounded-lg p-2 text-text-secondary hover:bg-surface-highlight"
        @click="closeMobile"
      >
        <X class="h-5 w-5" />
      </button>
    </div>

    <nav class="flex-1 space-y-1 px-4 py-4">
      <RouterLink
        v-for="item in navItems"
        :key="item.to"
        :to="item.to"
        :class="cn(
          'flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium transition-all duration-200',
          isActive(item.to)
            ? 'bg-primary-subtle text-primary'
            : 'text-text-secondary hover:bg-surface-highlight hover:text-text-primary',
        )"
        @click="closeMobile"
      >
        <component :is="item.icon" class="h-4 w-4" />
        {{ item.label }}
      </RouterLink>
    </nav>

    <div class="border-t border-border p-4">
      <slot name="footer" />
    </div>
  </aside>
</template>
