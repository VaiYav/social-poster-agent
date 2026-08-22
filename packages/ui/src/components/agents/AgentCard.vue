<script setup lang="ts">
import type { Component } from "vue";
import { Card, Button, Badge } from "../ui";
import type { AgentViewModel, AgentAction } from "../../stores/agents";

const props = defineProps<{
  agent: AgentViewModel;
  loadingAction?: string | null;
}>();

const emit = defineEmits<{
  action: [actionId: string, agentId: string];
}>();

const statusVariants: Record<
  AgentViewModel["status"],
  "success" | "warning" | "error" | "info" | "neutral"
> = {
  running: "success",
  paused: "warning",
  idle: "neutral",
  error: "error",
  warning: "warning",
  disabled: "neutral",
  unknown: "neutral",
};

function onAction(action: AgentAction) {
  emit("action", action.id, props.agent.id);
}
</script>

<template>
  <Card
    :class="`
      flex flex-col overflow-hidden transition-shadow
      ${
        agent.status === 'error'
          ? 'border-error/50 shadow-glow-error'
          : agent.status === 'warning'
            ? 'border-warning/50'
            : agent.status === 'running'
              ? 'border-success/30'
              : 'border-border'
      }
    `"
  >
    <div class="p-4">
      <div class="flex items-start justify-between gap-3">
        <div class="flex items-center gap-3">
          <div class="rounded-lg bg-surface-elevated p-2.5">
            <component :is="agent.icon" class="h-6 w-6 text-text-primary" />
          </div>
          <div>
            <h3 class="font-semibold text-text-primary">{{ agent.title }}</h3>
            <div class="mt-1 flex items-center gap-2">
              <Badge :variant="statusVariants[agent.status]">
                <template #dot><span /></template>
                {{ agent.statusLabel }}
              </Badge>
              <span v-if="agent.lastUpdated" class="text-xs text-text-muted">
                {{ new Date(agent.lastUpdated).toLocaleTimeString() }}
              </span>
            </div>
          </div>
        </div>
      </div>

      <p v-if="agent.message" class="mt-3 text-xs text-error">
        {{ agent.message }}
      </p>

      <div class="mt-4 grid grid-cols-2 gap-2">
        <div
          v-for="item in agent.summary"
          :key="item.label"
          class="rounded-md bg-surface-elevated p-2"
        >
          <div class="text-xs text-text-muted">{{ item.label }}</div>
          <div class="text-sm font-semibold text-text-primary">{{ item.value }}</div>
        </div>
      </div>
    </div>

    <div v-if="agent.actions.length > 0" class="mt-auto border-t border-border bg-surface/50 p-3">
      <div class="flex flex-wrap gap-2">
        <Button
          v-for="action in agent.actions"
          :key="action.id"
          :variant="action.variant ?? 'secondary'"
          size="sm"
          :loading="loadingAction === action.id"
          @click="onAction(action)"
        >
          <component :is="action.icon" v-if="action.icon" class="mr-1 h-3.5 w-3.5" />
          {{ action.label }}
        </Button>
      </div>
    </div>
  </Card>
</template>
