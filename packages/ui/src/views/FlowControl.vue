<script setup lang="ts">
/**
 * ADR-006: Flow Control view — pause/resume agent flows, crisis mode.
 *
 * This is the operator's emergency control panel. In autonomous mode, the
 * operator doesn't approve individual posts — they monitor and can pause
 * any flow if something goes wrong.
 */
import { onMounted, computed } from "vue";
import { AlertTriangle, Play, Pause, Activity, Zap, Scale, Bot } from "@lucide/vue";
import { useFlowControlStore, type FlowName } from "../stores/flowControl";
import { useToast } from "../composables/useToast";
import { Card, Button, SectionHeader, Badge } from "../components/ui";

const flowControl = useFlowControlStore();
const toast = useToast();

const flowLabels: Record<FlowName, string> = {
  generation: "Content Generation",
  posting: "Post Publishing",
  engagement: "Engagement (likes/comments)",
  replies: "Reply Monitoring",
  llm_triage: "LLM Triage",
  auto_approve: "Auto Approve",
};

const flowIcons: Record<FlowName, typeof Activity> = {
  generation: Zap,
  posting: Activity,
  engagement: AlertTriangle,
  replies: Activity,
  llm_triage: Scale,
  auto_approve: Bot,
};

const crisisActive = computed(() => flowControl.pauseAll);

async function toggleFlow(flow: FlowName) {
  if (flowControl.flows[flow]) {
    await flowControl.resumeFlow(flow);
    toast.success(`${flowLabels[flow]} resumed`);
  } else {
    await flowControl.pauseFlow(flow, "Manual pause from dashboard");
    toast.warning(`${flowLabels[flow]} paused`);
  }
}

async function toggleCrisis() {
  if (crisisActive.value) {
    await flowControl.resumeAllFlows();
    toast.success("Crisis mode deactivated — all flows resumed");
  } else {
    await flowControl.pauseAllFlows("Crisis mode activated by operator");
    toast.error("CRISIS MODE: All flows paused");
  }
}

onMounted(() => {
  flowControl.fetchStatus();
});
</script>

<template>
  <div class="space-y-6">
    <SectionHeader
      title="Flow Control"
      description="Pause/resume agent flows — emergency intervention"
    />

    <!-- Crisis Mode -->
    <Card class="p-6" :class="crisisActive ? 'border-red-500 bg-red-500/10' : ''">
      <div class="flex items-center justify-between">
        <div class="flex items-center gap-4">
          <div
            class="rounded-lg p-3"
            :class="crisisActive ? 'bg-red-500/20' : 'bg-surface-elevated'"
          >
            <AlertTriangle
              class="h-8 w-8"
              :class="crisisActive ? 'text-red-500' : 'text-text-secondary'"
            />
          </div>
          <div>
            <h3 class="text-lg font-semibold" :class="crisisActive ? 'text-red-500' : ''">
              {{ crisisActive ? "CRISIS MODE ACTIVE" : "Crisis Mode" }}
            </h3>
            <p class="text-sm text-text-secondary">
              {{
                crisisActive
                  ? "All agent flows are paused. No new content will be generated or posted."
                  : "Instantly pause ALL flows — generation, posting, engagement, replies."
              }}
            </p>
          </div>
        </div>
        <Button :variant="crisisActive ? 'primary' : 'destructive'" @click="toggleCrisis">
          <Pause v-if="!crisisActive" class="mr-2 h-4 w-4" />
          <Play v-else class="mr-2 h-4 w-4" />
          {{ crisisActive ? "Resume All" : "Pause All" }}
        </Button>
      </div>
    </Card>

    <!-- Individual Flow Controls -->
    <div class="grid gap-4 md:grid-cols-2">
      <Card
        v-for="(flow, key) in flowControl.flows"
        :key="key"
        class="p-5"
        :class="flow ? 'border-orange-500/50' : ''"
      >
        <div class="flex items-center justify-between">
          <div class="flex items-center gap-3">
            <component :is="flowIcons[key as FlowName]" class="h-6 w-6 text-text-secondary" />
            <div>
              <h4 class="font-medium">{{ flowLabels[key as FlowName] }}</h4>
              <Badge :variant="flow ? 'warning' : 'success'" class="mt-1">
                {{ flow ? "PAUSED" : "ACTIVE" }}
              </Badge>
            </div>
          </div>
          <Button
            :variant="flow ? 'primary' : 'secondary'"
            size="sm"
            @click="toggleFlow(key as FlowName)"
          >
            <Play v-if="flow" class="mr-1 h-3 w-3" />
            <Pause v-else class="mr-1 h-3 w-3" />
            {{ flow ? "Resume" : "Pause" }}
          </Button>
        </div>
      </Card>
    </div>

    <!-- Loading/Error -->
    <div v-if="flowControl.error" class="text-sm text-red-500">Error: {{ flowControl.error }}</div>
  </div>
</template>
