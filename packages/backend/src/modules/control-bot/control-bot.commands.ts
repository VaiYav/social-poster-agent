/**
 * TGBOT-101: pure command-parsing/formatting helpers for the operator control
 * bot. Kept free of NestJS/DI so the routing table is unit-testable directly.
 */

export interface ParsedCommand {
  name: string;
  args: string[];
}

/** Parse "/approve abc reason..." → {name:"approve", args:["abc","reason",...]}. */
export function parseCommand(text: string | undefined): ParsedCommand | null {
  if (!text || !text.startsWith("/")) return null;
  const [rawName, ...args] = text.trim().split(/\s+/);
  const name = rawName!.slice(1).split("@")[0]!.toLowerCase();
  if (!name) return null;
  return { name, args };
}

export const KNOWN_COMMANDS = [
  "/status",
  "/pending",
  "/approve <postId>",
  "/reject <postId> [reason]",
  "/pause <posting|generation|engagement|replies|all>",
  "/resume <posting|generation|engagement|replies|all>",
  "/help",
] as const;

export function helpText(): string {
  return [
    "SPA Control Bot — commands:",
    ...KNOWN_COMMANDS.map((c) => `  ${c}`),
    "",
    "Text editing stays in the dashboard.",
  ].join("\n");
}

const FLOW_NAMES = ["posting", "generation", "engagement", "replies"] as const;
export type FlowArg = (typeof FLOW_NAMES)[number] | "all";

export function parseFlowArg(arg: string | undefined): FlowArg | null {
  if (!arg) return null;
  const lower = arg.toLowerCase();
  if (lower === "all") return "all";
  return (FLOW_NAMES as readonly string[]).includes(lower) ? (lower as FlowArg) : null;
}

export function formatPending(
  drafts: Array<{ id: string; network: string; content: string }>,
): string {
  if (drafts.length === 0) return "No drafts awaiting review.";
  const lines = drafts.map((d) => {
    const hook = d.content.length > 80 ? `${d.content.slice(0, 77)}…` : d.content;
    return `• \`${d.id}\` [${d.network}] ${hook.replace(/\n/g, " ")}`;
  });
  return ["Drafts awaiting review:", ...lines].join("\n");
}

export interface StatusSnapshot {
  draftsPending: number;
  flows: Record<string, boolean>; // true = paused
  queue?: {
    waiting: number;
    active: number;
    delayed: number;
    failed: number;
  };
  orchestrator?: {
    enabled: boolean;
    running: boolean | null;
    cycle: number | null;
    heartbeatAgeMs: number | null;
  };
  todayCostUsd?: number | null;
}

export function formatStatus(snap: StatusSnapshot): string {
  const flowLines = Object.entries(snap.flows).map(([flow, paused]) => {
    const icon = paused ? "⏸" : "▶";
    return `  ${icon} ${flow}: ${paused ? "PAUSED" : "running"}`;
  });
  return [
    "SPA pipeline status:",
    snap.orchestrator
      ? `  orchestrator: ${snap.orchestrator.enabled ? (snap.orchestrator.running === true ? "RUNNING" : snap.orchestrator.running === false ? "STOPPED" : "UNKNOWN") : "disabled"}` +
        (snap.orchestrator.cycle === null ? "" : ` (cycle ${snap.orchestrator.cycle})`)
      : null,
    `  drafts pending review: ${snap.draftsPending}`,
    snap.queue
      ? `  queue: ${snap.queue.waiting} waiting, ${snap.queue.active} active, ${snap.queue.delayed} delayed, ${snap.queue.failed} failed`
      : null,
    snap.todayCostUsd === undefined
      ? null
      : `  today's LLM cost: $${(snap.todayCostUsd ?? 0).toFixed(6)}`,
    "flows:",
    ...flowLines,
  ].filter((line): line is string => line !== null).join("\n");
}
