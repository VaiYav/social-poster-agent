export type AgentStatus = 'running' | 'paused' | 'idle' | 'error' | 'warning' | 'disabled' | 'unknown';

export interface AgentState {
  status: AgentStatus;
  metrics: Record<string, unknown>;
  message?: string;
  lastUpdated?: number;
}

export interface MonitoringSnapshot {
  timestamp: number;
  agents: Record<string, AgentState>;
}

const VALID_AGENT_STATUS = new Set<AgentStatus>([
  'running',
  'paused',
  'idle',
  'error',
  'warning',
  'disabled',
  'unknown',
]);

export function isMetricsSnapshot(payload: unknown): payload is MonitoringSnapshot {
  if (payload === null || typeof payload !== 'object') return false;

  const p = payload as Record<string, unknown>;
  if (
    p.type !== 'metrics_snapshot' ||
    typeof p.timestamp !== 'number' ||
    p.agents === null ||
    typeof p.agents !== 'object' ||
    Array.isArray(p.agents)
  ) {
    return false;
  }

  const agents = p.agents as Record<string, unknown>;
  for (const agent of Object.values(agents)) {
    if (!agent || typeof agent !== 'object') return false;
    const a = agent as Record<string, unknown>;
    if (typeof a.status !== 'string' || !VALID_AGENT_STATUS.has(a.status as AgentStatus)) return false;
    if (a.metrics === null || typeof a.metrics !== 'object' || Array.isArray(a.metrics)) return false;
  }

  return true;
}
