<script setup lang="ts">
import { ref, computed, onMounted, watch } from "vue";
import {
  Calendar as CalendarIcon,
  ChevronLeft,
  ChevronRight,
  Clock,
  Filter,
  LayoutGrid,
  List,
  X,
} from "@lucide/vue";
import { useApi } from "../composables/useApi";
import { useToast } from "../composables/useToast";
import { Card, Button, SectionHeader, Badge, Select, Input } from "../components/ui";
import LoadingSpinner from "../components/LoadingSpinner.vue";
import ErrorState from "../components/ErrorState.vue";
import NetworkIcon from "../components/NetworkIcon.vue";

interface CalendarAccount {
  id: string;
  handle: string | null;
  network: string;
}

interface CalendarEvent {
  id: string;
  network: string;
  status: string;
  content: string;
  timestamp: string;
  account: CalendarAccount | null;
  postUrl: string | null;
  errorMessage: string | null;
}

const api = useApi();
const toast = useToast();

const events = ref<CalendarEvent[]>([]);
const loading = ref(false);
const error = ref<string | null>(null);
const currentDate = ref(new Date());
const view = ref<"month" | "week" | "day">("month");
const filterNetwork = ref("");
const filterStatus = ref("");

const selectedEvent = ref<CalendarEvent | null>(null);
const scheduleValue = ref("");
const scheduling = ref(false);

const weekdays = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

const statusOptions = [
  { value: "", label: "All statuses" },
  { value: "DRAFT", label: "Draft" },
  { value: "APPROVED", label: "Approved" },
  { value: "POSTING", label: "Posting" },
  { value: "POSTED", label: "Posted" },
  { value: "FAILED", label: "Failed" },
  { value: "REJECTED", label: "Rejected" },
];

const networkOptions = [
  { value: "", label: "All networks" },
  { value: "X", label: "X" },
  { value: "THREADS", label: "Threads" },
  { value: "FACEBOOK", label: "Facebook" },
];

const statusColor: Record<string, string> = {
  DRAFT: "border-l-gray-400 bg-surface",
  APPROVED: "border-l-blue-500 bg-blue-500/5",
  POSTING: "border-l-yellow-500 bg-yellow-500/5",
  POSTED: "border-l-green-500 bg-green-500/5",
  FAILED: "border-l-red-500 bg-red-500/5",
  REJECTED: "border-l-red-400 bg-red-400/5",
  JUDGED: "border-l-purple-500 bg-purple-500/5",
  VERIFIED: "border-l-teal-500 bg-teal-500/5",
};

const viewOptions = [
  { value: "month", label: "Month" },
  { value: "week", label: "Week" },
  { value: "day", label: "Day" },
];

function toISODate(d: Date): string {
  return d.toISOString().split("T")[0] ?? "";
}

function getMonthRange(d: Date): { from: string; to: string } {
  const year = d.getFullYear();
  const month = d.getMonth();
  const from = new Date(year, month, 1);
  const to = new Date(year, month + 1, 0, 23, 59, 59, 999);
  return { from: from.toISOString(), to: to.toISOString() };
}

function getWeekRange(d: Date): { from: string; to: string } {
  const start = new Date(d);
  start.setDate(d.getDate() - d.getDay());
  start.setHours(0, 0, 0, 0);
  const end = new Date(start);
  end.setDate(start.getDate() + 6);
  end.setHours(23, 59, 59, 999);
  return { from: start.toISOString(), to: end.toISOString() };
}

function getDayRange(d: Date): { from: string; to: string } {
  const start = new Date(d);
  start.setHours(0, 0, 0, 0);
  const end = new Date(d);
  end.setHours(23, 59, 59, 999);
  return { from: start.toISOString(), to: end.toISOString() };
}

async function loadEvents() {
  loading.value = true;
  error.value = null;
  try {
    const range =
      view.value === "month"
        ? getMonthRange(currentDate.value)
        : view.value === "week"
          ? getWeekRange(currentDate.value)
          : getDayRange(currentDate.value);
    const params: Record<string, string> = {
      from: range.from,
      to: range.to,
    };
    if (filterNetwork.value) params.network = filterNetwork.value;
    if (filterStatus.value) params.status = filterStatus.value;
    const res = await api.get<CalendarEvent[]>("/posts/calendar", { params });
    events.value = res.data;
  } catch (err) {
    error.value = (err as Error).message ?? "Failed to load calendar";
  } finally {
    loading.value = false;
  }
}

const monthLabel = computed(() => {
  return currentDate.value.toLocaleDateString("en-US", { month: "long", year: "numeric" });
});

const weekLabel = computed(() => {
  const { from, to } = getWeekRange(currentDate.value);
  const start = new Date(from);
  const end = new Date(to);
  return `${start.toLocaleDateString("en-US", { month: "short", day: "numeric" })} – ${end.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}`;
});

const dayLabel = computed(() => {
  return currentDate.value.toLocaleDateString("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
  });
});

const headerLabel = computed(() => {
  return view.value === "month"
    ? monthLabel.value
    : view.value === "week"
      ? weekLabel.value
      : dayLabel.value;
});

const eventsByDate = computed(() => {
  const map = new Map<string, CalendarEvent[]>();
  for (const event of events.value) {
    const date = event.timestamp.split("T")[0] ?? "";
    if (!map.has(date)) map.set(date, []);
    map.get(date)!.push(event);
  }
  return map;
});

const calendarDays = computed(() => {
  const year = currentDate.value.getFullYear();
  const month = currentDate.value.getMonth();
  const firstDay = new Date(year, month, 1);
  const start = new Date(firstDay);
  start.setDate(1 - firstDay.getDay());

  const days: { date: Date; dateStr: string; inMonth: boolean }[] = [];
  const total = 42; // 6 weeks
  for (let i = 0; i < total; i++) {
    const d = new Date(start);
    d.setDate(start.getDate() + i);
    days.push({
      date: d,
      dateStr: toISODate(d),
      inMonth: d.getMonth() === month,
    });
  }
  return days;
});

function prev() {
  if (view.value === "month") {
    currentDate.value = new Date(
      currentDate.value.getFullYear(),
      currentDate.value.getMonth() - 1,
      1,
    );
  } else if (view.value === "week") {
    currentDate.value = new Date(currentDate.value.getTime() - 7 * 24 * 60 * 60 * 1000);
  } else {
    currentDate.value = new Date(currentDate.value.getTime() - 24 * 60 * 60 * 1000);
  }
  loadEvents();
}

function next() {
  if (view.value === "month") {
    currentDate.value = new Date(
      currentDate.value.getFullYear(),
      currentDate.value.getMonth() + 1,
      1,
    );
  } else if (view.value === "week") {
    currentDate.value = new Date(currentDate.value.getTime() + 7 * 24 * 60 * 60 * 1000);
  } else {
    currentDate.value = new Date(currentDate.value.getTime() + 24 * 60 * 60 * 1000);
  }
  loadEvents();
}

function today() {
  currentDate.value = new Date();
  loadEvents();
}

function openEvent(event: CalendarEvent) {
  selectedEvent.value = event;
  const d = new Date(event.timestamp);
  d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
  scheduleValue.value = d.toISOString().slice(0, 16);
}

function closeModal() {
  selectedEvent.value = null;
}

async function saveSchedule() {
  if (!selectedEvent.value || !scheduleValue.value) return;
  scheduling.value = true;
  try {
    await api.patch(`/posts/${selectedEvent.value.id}/schedule`, {
      scheduledAt: new Date(scheduleValue.value).toISOString(),
    });
    toast.success("Post rescheduled");
    closeModal();
    await loadEvents();
  } catch (err) {
    toast.error((err as Error).message ?? "Failed to reschedule post");
  } finally {
    scheduling.value = false;
  }
}

function formatTime(iso: string): string {
  return new Date(iso).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" });
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

watch([filterNetwork, filterStatus], loadEvents, { immediate: false });

onMounted(() => {
  loadEvents();
});
</script>

<template>
  <div>
    <SectionHeader
      title="Content Calendar"
      description="Visual schedule of posts across networks (F7)."
    />

    <Card>
      <template #header>
        <div class="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
          <div class="flex items-center gap-3">
            <CalendarIcon class="h-5 w-5 text-primary" />
            <h2 class="text-lg font-semibold text-text-primary">{{ headerLabel }}</h2>
          </div>

          <div class="flex flex-wrap items-center gap-3">
            <div class="flex items-center rounded-md border border-border bg-surface-elevated p-1">
              <button
                v-for="v in viewOptions"
                :key="v.value"
                :class="[
                  'rounded px-3 py-1 text-xs font-medium transition-colors',
                  view === v.value
                    ? 'bg-primary text-white'
                    : 'text-text-secondary hover:text-text-primary',
                ]"
                @click="
                  view = v.value as 'month' | 'week' | 'day';
                  loadEvents();
                "
              >
                {{ v.label }}
              </button>
            </div>

            <div class="flex items-center gap-1">
              <Button size="sm" variant="ghost" @click="prev">
                <ChevronLeft class="h-4 w-4" />
              </Button>
              <Button size="sm" variant="outline" @click="today">Today</Button>
              <Button size="sm" variant="ghost" @click="next">
                <ChevronRight class="h-4 w-4" />
              </Button>
            </div>
          </div>
        </div>

        <div class="mt-4 flex flex-col gap-3 sm:flex-row">
          <div class="flex items-center gap-2 text-sm text-text-secondary">
            <Filter class="h-4 w-4" />
            <span>Filters</span>
          </div>
          <Select v-model="filterNetwork" :options="networkOptions" class="sm:w-40" />
          <Select v-model="filterStatus" :options="statusOptions" class="sm:w-40" />
        </div>
      </template>

      <LoadingSpinner v-if="loading" />
      <ErrorState v-else-if="error" :message="error" />

      <!-- Month view -->
      <div
        v-else-if="view === 'month'"
        class="grid grid-cols-7 gap-px rounded-md border border-border bg-border"
      >
        <div
          v-for="day in weekdays"
          :key="day"
          class="bg-surface-elevated p-2 text-center text-xs font-semibold text-text-secondary"
        >
          {{ day }}
        </div>
        <div
          v-for="day in calendarDays"
          :key="day.dateStr"
          :class="[
            'min-h-[120px] bg-surface p-2 transition-colors hover:bg-surface-highlight',
            day.inMonth ? 'text-text-primary' : 'text-text-muted',
          ]"
        >
          <div class="mb-1 text-right text-sm font-medium">
            {{ day.date.getDate() }}
          </div>
          <div class="space-y-1">
            <button
              v-for="event in eventsByDate.get(day.dateStr) ?? []"
              :key="event.id"
              :class="[
                'w-full rounded border-l-2 px-2 py-1 text-left text-xs',
                statusColor[event.status] ?? 'border-l-gray-400 bg-surface',
              ]"
              @click="openEvent(event)"
            >
              <div class="flex items-center gap-1">
                <NetworkIcon :network="event.network" class="h-3 w-3" />
                <span class="font-medium">{{ event.status }}</span>
              </div>
              <p class="line-clamp-2 text-text-secondary">{{ event.content }}</p>
            </button>
          </div>
        </div>
      </div>

      <!-- Week / Day list -->
      <div v-else class="space-y-2">
        <div
          v-for="[dateStr, dayEvents] in eventsByDate"
          :key="dateStr"
          class="rounded-lg border border-border p-3"
        >
          <div class="mb-2 text-sm font-semibold text-text-primary">
            {{ formatDate(dateStr) }}
          </div>
          <div class="space-y-2">
            <button
              v-for="event in dayEvents"
              :key="event.id"
              :class="[
                'w-full rounded border-l-2 px-3 py-2 text-left text-sm',
                statusColor[event.status] ?? 'border-l-gray-400 bg-surface',
              ]"
              @click="openEvent(event)"
            >
              <div class="flex items-center gap-2">
                <NetworkIcon :network="event.network" class="h-4 w-4" />
                <Badge
                  :variant="
                    event.status === 'POSTED'
                      ? 'success'
                      : event.status === 'FAILED' || event.status === 'REJECTED'
                        ? 'error'
                        : 'default'
                  "
                >
                  {{ event.status }}
                </Badge>
                <span class="ml-auto text-xs text-text-muted">{{
                  formatTime(event.timestamp)
                }}</span>
              </div>
              <p class="mt-1 text-text-secondary">{{ event.content }}</p>
            </button>
          </div>
        </div>
        <div v-if="eventsByDate.size === 0" class="py-8 text-center text-text-muted">
          No posts for this period.
        </div>
      </div>
    </Card>

    <!-- Reschedule modal -->
    <div
      v-if="selectedEvent"
      class="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
      @click.self="closeModal"
    >
      <Card class="w-full max-w-md">
        <template #header>
          <div class="flex items-center justify-between">
            <h3 class="text-lg font-semibold text-text-primary">Reschedule Post</h3>
            <button class="rounded p-1 text-text-muted hover:text-text-primary" @click="closeModal">
              <X class="h-4 w-4" />
            </button>
          </div>
        </template>

        <div class="space-y-4" v-if="selectedEvent">
          <div
            class="rounded-md border border-border bg-surface-elevated p-3 text-sm text-text-secondary"
          >
            <p class="line-clamp-3">{{ selectedEvent.content }}</p>
            <div class="mt-2 flex items-center gap-2 text-xs text-text-muted">
              <NetworkIcon :network="selectedEvent.network" class="h-3 w-3" />
              <span>{{ selectedEvent.network }}</span>
              <Badge size="sm">{{ selectedEvent.status }}</Badge>
            </div>
          </div>

          <div>
            <label class="mb-1.5 block text-sm font-medium text-text-secondary">
              <Clock class="mr-1 inline h-4 w-4" />
              Scheduled at
            </label>
            <Input v-model="scheduleValue" type="datetime-local" />
            <p class="mt-1 text-xs text-text-muted">
              DRAFT posts keep their status; APPROVED/POSTING posts are re-enqueued.
            </p>
          </div>

          <div class="flex justify-end gap-2">
            <Button variant="ghost" @click="closeModal">Cancel</Button>
            <Button :loading="scheduling" :disabled="scheduling" @click="saveSchedule">
              Save Schedule
            </Button>
          </div>
        </div>
      </Card>
    </div>
  </div>
</template>
