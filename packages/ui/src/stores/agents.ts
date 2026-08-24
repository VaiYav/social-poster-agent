/**
 * Unified agents store — real-time system snapshot and global agent controls.
 *
 * Subscribes to the existing SSE channel (`metrics_snapshot`) and REST-falls-back to
 * `/monitoring/snapshot`. Exposes every subsystem as an `AgentViewModel` with status,
 * summary metrics, and action buttons. Action execution dispatches to the relevant
 * backend endpoints.
 */
import { defineStore } from "pinia";
import { ref, computed, type Component } from "vue";
import { isMetricsSnapshot, type MonitoringSnapshot, type AgentState } from "../types/monitoring";
import api from "../composables/useApi";
import type { SSEvent } from "@spa/shared";
import { useToast } from "../composables/useToast";
import {
  Activity,
  BarChart3,
  Bot,
  Brain,
  BrainCircuit,
  Gauge,
  Globe,
  Heart,
  ListChecks,
  MessageSquare,
  RefreshCw,
  Send,
  ShieldAlert,
  Sparkles,
  TrendingUp,
  Zap,
} from "@lucide/vue";

export type ButtonVariant = "primary" | "secondary" | "outline" | "ghost" | "destructive";

export interface AgentAction {
  id: string;
  label: string;
  variant?: ButtonVariant;
  icon?: Component;
  handler?: () => Promise<string>;
}

export interface AgentMetricItem {
  label: string;
  value: string | number;
}

export interface AgentViewModel {
  id: string;
  title: string;
  icon: Component;
  status: AgentState["status"];
  statusLabel: string;
  summary: AgentMetricItem[];
  message?: string;
  lastUpdated?: number;
  actions: AgentAction[];
  raw: AgentState;
}

const NETWORKS = ["X", "THREADS", "FACEBOOK"] as const;

function fmt(value: unknown): string | number {
  if (value === null || value === undefined) return "—";
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (typeof value === "number") return value;
  if (typeof value === "string") return value;
  if (value instanceof Date) return value.toLocaleString();
  return "—";
}

function metric(label: string, value: unknown): AgentMetricItem {
  return { label, value: fmt(value) };
}

type BuildSummary = (metrics: Record<string, unknown>) => AgentMetricItem[];

interface AgentDefinition {
  title: string;
  icon: Component;
  buildSummary: BuildSummary;
  actions: AgentAction[];
}

const agentDefinitions: Record<string, AgentDefinition> = {
  health: {
    title: "Health Monitor",
    icon: Activity,
    buildSummary: (metrics) => [
      metric("Alerts", metrics.totalAlerts ?? metrics.critical ?? 0),
      metric("Critical", metrics.critical ?? 0),
      metric("Healthy sessions", metrics.healthySessions ?? 0),
      metric("Banned sessions", metrics.bannedSessions ?? 0),
    ],
    actions: [
      {
        id: "health.check",
        label: "Health check",
        variant: "secondary",
        icon: Activity,
        handler: async () => {
          await api.post("/health-monitor/check");
          return "Health check started";
        },
      },
      {
        id: "health.reconcile",
        label: "Reconcile",
        variant: "outline",
        icon: RefreshCw,
        handler: async () => {
          await api.post("/health-monitor/reconcile");
          return "Reconciliation started";
        },
      },
    ],
  },
  queue: {
    title: "BullMQ Posting Queue",
    icon: ListChecks,
    buildSummary: (metrics) => [
      metric("Failed", metrics.totalFailed ?? 0),
      metric("Waiting", metrics.totalWaiting ?? 0),
      metric("Active", metrics.totalActive ?? 0),
      metric("Paused", metrics.pausedCount ?? 0),
    ],
    actions: [
      {
        id: "queue.pause-all",
        label: "Pause all",
        variant: "outline",
        handler: async () => {
          await Promise.all(NETWORKS.map((network) => api.post(`/queue/${network}/pause`)));
          return "All queues paused";
        },
      },
      {
        id: "queue.resume-all",
        label: "Resume all",
        variant: "secondary",
        handler: async () => {
          await Promise.all(NETWORKS.map((network) => api.post(`/queue/${network}/resume`)));
          return "All queues resumed";
        },
      },
      {
        id: "queue.retry-all-failed",
        label: "Retry failed",
        variant: "secondary",
        handler: async () => {
          await Promise.all(NETWORKS.map((network) => api.post(`/queue/${network}/retry-failed`)));
          return "Retrying failed jobs across all queues";
        },
      },
      {
        id: "queue.clear-all-completed",
        label: "Clear completed",
        variant: "ghost",
        handler: async () => {
          await Promise.all(
            NETWORKS.map((network) => api.post(`/queue/${network}/clear-completed`)),
          );
          return "Completed jobs cleared";
        },
      },
    ],
  },
  sessions: {
    title: "Browser Sessions",
    icon: Globe,
    buildSummary: (metrics) => [
      metric("Total", metrics.total ?? 0),
      metric("Active", (metrics.counts as Record<string, number> | undefined)?.ACTIVE ?? 0),
      metric("Expired", (metrics.counts as Record<string, number> | undefined)?.EXPIRED ?? 0),
      metric("Banned", (metrics.counts as Record<string, number> | undefined)?.BANNED ?? 0),
    ],
    actions: [
      {
        id: "sessions.health-check-all",
        label: "Health check all",
        variant: "secondary",
        icon: Activity,
        handler: async () => {
          await Promise.all(
            NETWORKS.map((network) =>
              api.post("/sessions/health-check", undefined, { params: { network } }),
            ),
          );
          return "Session health checks triggered";
        },
      },
    ],
  },
  rateLimits: {
    title: "Rate Limits",
    icon: Gauge,
    buildSummary: (metrics) => [metric("Exceeded", metrics.exceededCount ?? 0)],
    actions: [],
  },
  analytics: {
    title: "Analytics",
    icon: BarChart3,
    buildSummary: (metrics) => [
      metric("Total posts", metrics.totalPosts ?? 0),
      metric("Posted", metrics.posted ?? 0),
      metric("Failed", metrics.failed ?? 0),
      metric("Success rate", `${metrics.successRate ?? 0}%`),
    ],
    actions: [
      {
        id: "analytics.scrape",
        label: "Scrape metrics",
        variant: "secondary",
        icon: RefreshCw,
        handler: async () => {
          await api.post("/analytics/scrape");
          return "Metrics scrape triggered";
        },
      },
      {
        id: "analytics.aggregate-hooks",
        label: "Aggregate hooks",
        variant: "outline",
        icon: Brain,
        handler: async () => {
          await api.post("/analytics/hook-performance/aggregate");
          return "Hook performance aggregation triggered";
        },
      },
    ],
  },
  trending: {
    title: "Trending Scraper",
    icon: TrendingUp,
    buildSummary: (metrics) => [
      metric(
        "Google cached",
        ((metrics.googleTrends as Record<string, unknown> | undefined)?.cached as boolean) ?? false,
      ),
      metric(
        "X cached",
        ((metrics.xTrends as Record<string, unknown> | undefined)?.cached as boolean) ?? false,
      ),
    ],
    actions: [
      {
        id: "trending.refresh",
        label: "Refresh X + Google",
        variant: "secondary",
        icon: RefreshCw,
        handler: async () => {
          await api.get("/trending/merged");
          return "Trending refresh triggered";
        },
      },
    ],
  },
  llm: {
    title: "LLM Providers",
    icon: BrainCircuit,
    buildSummary: (metrics) => [
      metric("Providers", metrics.providerCount ?? 0),
      metric("Open circuits", metrics.openCircuits ?? 0),
      metric("Rate limited", metrics.rateLimited ?? 0),
    ],
    actions: [
      {
        id: "llm.reset-circuit-breakers",
        label: "Reset breakers",
        variant: "outline",
        icon: RefreshCw,
        handler: async () => {
          await api.post("/generation/reset-circuit-breakers");
          return "Circuit breakers reset";
        },
      },
    ],
  },
  flowControl: {
    title: "Flow Control",
    icon: ShieldAlert,
    buildSummary: (metrics) => [
      metric("Crisis mode", metrics.pauseAll ?? false),
      metric(
        "Generation paused",
        (metrics.flows as Record<string, boolean> | undefined)?.generation ?? false,
      ),
      metric(
        "Posting paused",
        (metrics.flows as Record<string, boolean> | undefined)?.posting ?? false,
      ),
      metric(
        "Engagement paused",
        (metrics.flows as Record<string, boolean> | undefined)?.engagement ?? false,
      ),
    ],
    actions: [
      {
        id: "flow-control.pause-all",
        label: "Pause all flows",
        variant: "destructive",
        handler: async () => {
          await api.post("/flow-control/pause-all", {
            reason: "Operator paused all flows from dashboard",
          });
          return "All flows paused";
        },
      },
      {
        id: "flow-control.resume-all",
        label: "Resume all flows",
        variant: "primary",
        handler: async () => {
          await api.post("/flow-control/resume-all");
          return "All flows resumed";
        },
      },
    ],
  },
  orchestrator: {
    title: "Orchestrator",
    icon: Bot,
    buildSummary: (metrics) => [
      metric("Enabled", metrics.enabled ?? false),
      metric("Running", metrics.running ?? false),
      metric("Cycle", metrics.cycle ?? 0),
      metric(
        "Heartbeat age",
        metrics.heartbeatAgeMs != null
          ? `${Math.round((metrics.heartbeatAgeMs as number) / 1000)}s`
          : "—",
      ),
    ],
    actions: [
      {
        id: "orchestrator.pause",
        label: "Pause",
        variant: "outline",
        handler: async () => {
          await api.post("/orchestrator/pause");
          return "Orchestrator paused";
        },
      },
      {
        id: "orchestrator.resume",
        label: "Resume",
        variant: "secondary",
        handler: async () => {
          await api.post("/orchestrator/resume");
          return "Orchestrator resumed";
        },
      },
      {
        id: "orchestrator.restart",
        label: "Restart",
        variant: "primary",
        handler: async () => {
          await api.post("/orchestrator/restart");
          return "Orchestrator restart requested";
        },
      },
      {
        id: "orchestrator.reset",
        label: "Reset checkpoint",
        variant: "ghost",
        handler: async () => {
          await api.post("/orchestrator/reset");
          return "Orchestrator checkpoint reset";
        },
      },
    ],
  },
  engagement: {
    title: "Engagement",
    icon: Heart,
    buildSummary: (metrics) => [
      metric("Total interactions", metrics.total ?? 0),
      metric("Completed", metrics.completed ?? 0),
      metric("Active browsing", metrics.activeBrowsing ?? 0),
    ],
    actions: [],
  },
  replies: {
    title: "Replies Monitor",
    icon: MessageSquare,
    buildSummary: (metrics) => [
      metric("Total comments", metrics.total ?? 0),
      metric("Human review", metrics.humanReview ?? 0),
      metric("Replied", (metrics.counts as Record<string, number> | undefined)?.REPLIED ?? 0),
    ],
    actions: [
      {
        id: "replies.run-cycle",
        label: "Run cycle",
        variant: "secondary",
        icon: RefreshCw,
        handler: async () => {
          await api.post("/replies/run");
          return "Replies cycle triggered";
        },
      },
    ],
  },
  generation: {
    title: "Generation",
    icon: Sparkles,
    buildSummary: (metrics) => [
      metric("Total runs", metrics.total ?? 0),
      metric("Running", metrics.running ?? 0),
      metric("Completed", metrics.completed ?? 0),
      metric("Failed", metrics.failed ?? 0),
    ],
    actions: [
      {
        id: "generation.trigger",
        label: "Trigger run",
        variant: "primary",
        icon: Zap,
        handler: async () => {
          await api.post("/generation/run", { count: 3 });
          return "Generation run triggered";
        },
      },
      {
        id: "generation.reset-circuit-breakers",
        label: "Reset breakers",
        variant: "outline",
        icon: RefreshCw,
        handler: async () => {
          await api.post("/generation/reset-circuit-breakers");
          return "Circuit breakers reset";
        },
      },
    ],
  },
  posting: {
    title: "Posting",
    icon: Send,
    buildSummary: (metrics) => [
      metric("Approved", metrics.approved ?? 0),
      metric("Posting", metrics.posting ?? 0),
      metric("Failed", metrics.failed ?? 0),
      metric("Completed", metrics.completed ?? 0),
    ],
    actions: [
      {
        id: "posting.post-all-approved",
        label: "Post all approved",
        variant: "primary",
        icon: Send,
        handler: async () => {
          await api.post("/posting/batch/all-approved");
          return "Posting all approved posts";
        },
      },
    ],
  },
};

const statusLabels: Record<AgentState["status"], string> = {
  running: "Running",
  paused: "Paused",
  idle: "Idle",
  error: "Error",
  warning: "Warning",
  disabled: "Disabled",
  unknown: "Unknown",
};

function defaultSummary(metrics: Record<string, unknown>): AgentMetricItem[] {
  return Object.entries(metrics)
    .slice(0, 4)
    .map(([key, value]) => metric(key, value));
}

const actionRegistry = new Map<string, () => Promise<string>>();
Object.values(agentDefinitions).forEach((def) => {
  def.actions.forEach((action) => {
    if (action.handler) {
      actionRegistry.set(action.id, action.handler);
    }
  });
});

export const useAgentsStore = defineStore("agents", () => {
  const toast = useToast();

  const snapshot = ref<MonitoringSnapshot | null>(null);
  const loading = ref(false);
  const error = ref<string | null>(null);
  const lastSseEvent = ref<{ type: string; timestamp: number } | null>(null);

  const agents = computed<AgentViewModel[]>(() => {
    if (!snapshot.value) return [];
    const entries = Object.entries(snapshot.value.agents);
    return entries.map(([id, state]) => {
      const def = agentDefinitions[id] ?? {
        title: id,
        icon: Activity,
        buildSummary: defaultSummary,
        actions: [],
      };
      return {
        id,
        title: def.title,
        icon: def.icon,
        status: state.status,
        statusLabel: statusLabels[state.status] ?? state.status,
        summary: def.buildSummary(state.metrics),
        message: state.message,
        lastUpdated: state.lastUpdated ?? snapshot.value?.timestamp,
        actions: def.actions,
        raw: state,
      };
    });
  });

  const agentById = computed(() => {
    const map: Record<string, AgentViewModel> = {};
    for (const a of agents.value) map[a.id] = a;
    return map;
  });

  async function fetchSnapshot() {
    loading.value = true;
    error.value = null;
    try {
      const { data } = await api.get<MonitoringSnapshot>("/monitoring/snapshot");
      snapshot.value = data;
    } catch (err) {
      error.value = (err as Error).message;
    } finally {
      loading.value = false;
    }
  }

  function handleSseEvent(data: SSEvent) {
    lastSseEvent.value = { type: data.type, timestamp: Date.now() };
    if (isMetricsSnapshot(data)) {
      snapshot.value = data;
    }
  }

  async function execute(actionId: string, agentId?: string) {
    try {
      const agent = agentId ? agentDefinitions[agentId] : undefined;
      const action = agent?.actions.find((a) => a.id === actionId);
      const handler = action?.handler ?? actionRegistry.get(actionId);
      if (!handler) {
        toast.error(`Unknown action: ${actionId}`);
        return;
      }
      const message = await handler();
      toast.success(message);
    } catch (err) {
      toast.error(`Action failed: ${(err as Error).message}`);
      throw err;
    } finally {
      // Refresh the live snapshot after a short delay so controls reflect state changes.
      setTimeout(() => fetchSnapshot(), 500);
    }
  }

  return {
    snapshot,
    loading,
    error,
    lastSseEvent,
    agents,
    agentById,
    fetchSnapshot,
    handleSseEvent,
    execute,
  };
});
