/**
 * Real-time monitoring metrics publisher.
 *
 * Periodically collects a snapshot of all agent/subsystem states and publishes
 * it as a `metrics_snapshot` event over the existing SSE channel. Also exposes
 * the latest snapshot on demand via `MonitoringController`.
 *
 * Uses existing services to avoid duplicating business logic; every collector is
 * wrapped in try/catch so the snapshot is still useful even if one subsystem is
 * disabled or throwing.
 */
import { Inject, Injectable, Logger, OnModuleInit, OnModuleDestroy } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { SseService } from "../../infrastructure/sse/sse.service";
import { AgentState, IMetricsCollector, MonitoringSnapshot } from "./metrics-collector.js";

export { AgentState, MonitoringSnapshot };

@Injectable()
export class MetricsPublisher implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(MetricsPublisher.name);
  private readonly intervalMs: number;
  private timer: NodeJS.Timeout | null = null;
  private latestSnapshot: MonitoringSnapshot | null = null;
  private isCollecting = false;

  constructor(
    private readonly configService: ConfigService,
    private readonly sseService: SseService,
    @Inject(IMetricsCollector) private readonly collectors: IMetricsCollector[],
  ) {
    const raw = this.configService.get<string>("METRICS_SSE_INTERVAL_MS", "5000");
    this.intervalMs = raw ? Number(raw) : 5000;
  }

  onModuleInit(): void {
    if (this.intervalMs > 0) {
      // First snapshot after a short delay so SseService is fully initialised.
      setTimeout(() => this.collectAndPublish(), 500);
      this.timer = setInterval(() => this.collectAndPublish(), this.intervalMs);
      this.logger.log(`Metrics publisher started — interval ${this.intervalMs}ms`);
    } else {
      this.logger.log("Metrics publisher disabled — METRICS_SSE_INTERVAL_MS is 0");
    }
  }

  onModuleDestroy(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  getLatestSnapshot(): MonitoringSnapshot | null {
    return this.latestSnapshot;
  }

  async collectAndPublish(): Promise<void> {
    if (this.isCollecting) {
      this.logger.debug("Snapshot still collecting — skipping this tick");
      return;
    }
    this.isCollecting = true;
    try {
      const snapshot = await this.collectSnapshot();
      this.latestSnapshot = snapshot;
      await this.sseService.publish({
        type: "metrics_snapshot",
        timestamp: snapshot.timestamp,
        agents: snapshot.agents,
      });
    } catch (err) {
      this.logger.error(`Failed to publish metrics snapshot: ${(err as Error).message}`);
    } finally {
      this.isCollecting = false;
    }
  }

  async collectSnapshot(): Promise<MonitoringSnapshot> {
    const timestamp = Date.now();
    const results = await Promise.all(this.collectors.map((collector) => collector.collect()));

    const agents: Record<string, AgentState> = {};
    for (const [i, collector] of this.collectors.entries()) {
      const state = results[i];
      if (state) {
        agents[collector.id] = state;
      }
    }

    return { timestamp, agents };
  }
}
