export interface AgentState {
  status: 'running' | 'paused' | 'idle' | 'error' | 'warning' | 'disabled' | 'unknown';
  metrics: Record<string, unknown>;
  message?: string;
  lastUpdated?: number;
}

export interface MonitoringSnapshot {
  timestamp: number;
  agents: Record<string, AgentState>;
}

export const IMetricsCollector = Symbol('IMetricsCollector');

export interface IMetricsCollector {
  readonly id: string;
  collect(): Promise<AgentState>;
}
