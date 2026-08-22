import { Injectable, Optional } from "@nestjs/common";
import { AgentState, IMetricsCollector } from "./metrics-collector.js";
import { HealthMonitorService } from "../health-monitor/health-monitor.service";
import { QueueService } from "../queue/queue.service";
import { SessionsService } from "../sessions/sessions.service";
import { RateLimitService } from "../rate-limit/rate-limit.service";
import { AnalyticsService } from "../analytics/analytics.service";
import { TrendingScraperService } from "../trending/trending-scraper.service";
import { LlmService } from "../../infrastructure/llm/llm.service";
import { FlowControlService } from "../flow-control/flow-control.service";
import { PrismaService } from "../../infrastructure/prisma/prisma.service";
import { OrchestratorService } from "../orchestrator/orchestrator.service.js";
import { getEnabledNetworks } from "../../domain/enabled-networks.js";
import {
  SocialNetwork,
  CommentStatus,
  BrowsingSessionStatus,
  InteractionStatus,
  SessionStatus,
} from "../../generated/prisma/client";

@Injectable()
export class HealthMetricsCollector implements IMetricsCollector {
  public readonly id = "health";

  constructor(private readonly healthMonitorService: HealthMonitorService) {}

  async collect(): Promise<AgentState> {
    try {
      const dashboard = await this.healthMonitorService.getDashboard();
      const critical = dashboard.summary?.criticalAlerts ?? 0;
      const warning = dashboard.summary?.warningAlerts ?? 0;
      let status: AgentState["status"] = "running";
      if (critical > 0) status = "error";
      else if (warning > 0) status = "warning";
      return {
        status,
        metrics: {
          totalAlerts: dashboard.summary?.totalAlerts ?? 0,
          critical,
          warning,
          healthySessions: dashboard.summary?.healthySessions ?? 0,
          bannedSessions: dashboard.summary?.bannedSessions ?? 0,
          expiredSessions: dashboard.summary?.expiredSessions ?? 0,
        },
      };
    } catch (err) {
      return { status: "unknown", metrics: {}, message: (err as Error).message };
    }
  }
}

@Injectable()
export class QueueMetricsCollector implements IMetricsCollector {
  public readonly id = "queue";

  constructor(private readonly queueService: QueueService) {}

  async collect(): Promise<AgentState> {
    const networks = getEnabledNetworks();
    const perNetwork: Record<string, unknown> = {};
    let totalFailed = 0;
    let totalWaiting = 0;
    let totalActive = 0;
    let pausedCount = 0;
    let anyQueue = false;

    for (const network of networks) {
      try {
        const [counts, paused] = await Promise.all([
          this.queueService.getJobCounts(network),
          this.queueService.isQueuePaused(network),
        ]);
        anyQueue = true;
        perNetwork[network] = { counts, paused };
        totalFailed += counts.failed ?? 0;
        totalWaiting += counts.waiting ?? 0;
        totalActive += counts.active ?? 0;
        if (paused) pausedCount++;
      } catch (err) {
        perNetwork[network] = { error: (err as Error).message };
      }
    }

    if (!anyQueue) {
      return { status: "disabled", metrics: { perNetwork } };
    }

    let status: AgentState["status"] = "idle";
    if (pausedCount > 0) status = "paused";
    else if (totalFailed > 0) status = "error";
    else if (totalActive > 0) status = "running";
    else if (totalWaiting > 0) status = "warning";

    return {
      status,
      metrics: {
        totalFailed,
        totalWaiting,
        totalActive,
        pausedCount,
        perNetwork,
      },
    };
  }
}

@Injectable()
export class SessionsMetricsCollector implements IMetricsCollector {
  public readonly id = "sessions";

  constructor(private readonly sessionsService: SessionsService) {}

  async collect(): Promise<AgentState> {
    try {
      const sessions = await this.sessionsService.findAll();
      const counts: Record<string, number> = {};
      for (const status of Object.values(SessionStatus)) {
        counts[status] = 0;
      }
      for (const session of sessions) {
        counts[session.status] = (counts[session.status] ?? 0) + 1;
      }

      const banned = counts["BANNED"] ?? 0;
      const expired = counts["EXPIRED"] ?? 0;
      const active = counts["ACTIVE"] ?? 0;
      const status =
        banned > 0 ? "error" : expired > 0 ? "warning" : active > 0 ? "running" : "idle";
      return {
        status,
        metrics: { total: sessions.length, counts },
      };
    } catch (err) {
      return { status: "unknown", metrics: {}, message: (err as Error).message };
    }
  }
}

@Injectable()
export class RateLimitsMetricsCollector implements IMetricsCollector {
  public readonly id = "rateLimits";

  constructor(private readonly rateLimitService: RateLimitService) {}

  async collect(): Promise<AgentState> {
    const networks = getEnabledNetworks();
    const perNetwork: Record<string, unknown> = {};
    let anyLimit = false;
    let exceededCount = 0;

    for (const network of networks) {
      try {
        const status = await this.rateLimitService.getStatus(network);
        anyLimit = true;
        perNetwork[network] = status;
        if (status.dailyCount >= status.dailyLimit || status.weeklyCount >= status.weeklyLimit) {
          exceededCount++;
        }
      } catch (err) {
        perNetwork[network] = { error: (err as Error).message };
      }
    }

    return {
      status: anyLimit ? (exceededCount > 0 ? "error" : "running") : "disabled",
      metrics: { exceededCount, perNetwork },
    };
  }
}

@Injectable()
export class AnalyticsMetricsCollector implements IMetricsCollector {
  public readonly id = "analytics";

  constructor(private readonly analyticsService: AnalyticsService) {}

  async collect(): Promise<AgentState> {
    try {
      const summary = await this.analyticsService.getSummary();
      const status = summary.failed > 0 ? "warning" : summary.posted > 0 ? "running" : "idle";
      return {
        status,
        metrics: {
          totalPosts: summary.totalPosts,
          posted: summary.posted,
          failed: summary.failed,
          pending: summary.pending,
          successRate: summary.successRate,
        },
      };
    } catch (err) {
      return { status: "unknown", metrics: {}, message: (err as Error).message };
    }
  }
}

@Injectable()
export class TrendingMetricsCollector implements IMetricsCollector {
  public readonly id = "trending";

  constructor(private readonly trendingScraperService: TrendingScraperService) {}

  async collect(): Promise<AgentState> {
    try {
      const cache = this.trendingScraperService.getCacheStatus();
      const now = Date.now();
      const googleExpired =
        !cache.googleTrends.cached ||
        (cache.googleTrends.expiresAt && cache.googleTrends.expiresAt.getTime() < now);
      const xExpired =
        !cache.xTrends.cached ||
        (cache.xTrends.expiresAt && cache.xTrends.expiresAt.getTime() < now);
      const status = googleExpired || xExpired ? "warning" : "running";
      return {
        status,
        metrics: {
          googleTrends: cache.googleTrends,
          xTrends: cache.xTrends,
        },
      };
    } catch (err) {
      return { status: "unknown", metrics: {}, message: (err as Error).message };
    }
  }
}

@Injectable()
export class LlmMetricsCollector implements IMetricsCollector {
  public readonly id = "llm";

  constructor(private readonly llmService: LlmService) {}

  async collect(): Promise<AgentState> {
    try {
      const providers = this.llmService.getProviderStatus();
      const openCircuits = providers.filter((p) => p.circuitOpen).length;
      const rateLimited = providers.filter(
        (p) => p.rateLimitUntil && p.rateLimitUntil > Date.now(),
      ).length;
      const status = openCircuits > 0 ? "error" : rateLimited > 0 ? "warning" : "running";
      return {
        status,
        metrics: {
          providerCount: providers.length,
          openCircuits,
          rateLimited,
          providers,
        },
      };
    } catch (err) {
      return { status: "unknown", metrics: {}, message: (err as Error).message };
    }
  }
}

@Injectable()
export class FlowControlMetricsCollector implements IMetricsCollector {
  public readonly id = "flowControl";

  constructor(private readonly flowControlService: FlowControlService) {}

  async collect(): Promise<AgentState> {
    try {
      const status = await this.flowControlService.getStatus();
      const anyPaused = Object.values(status.flows).some(Boolean);
      return {
        status: status.pauseAll ? "paused" : anyPaused ? "warning" : "running",
        metrics: status,
      };
    } catch (err) {
      return { status: "unknown", metrics: {}, message: (err as Error).message };
    }
  }
}

@Injectable()
export class OrchestratorMetricsCollector implements IMetricsCollector {
  public readonly id = "orchestrator";

  constructor(@Optional() private readonly orchestratorService?: OrchestratorService) {}

  async collect(): Promise<AgentState> {
    if (!this.orchestratorService) {
      return { status: "disabled", metrics: { enabled: false } };
    }
    try {
      const status = await this.orchestratorService.getStatus();
      const heartbeatAge = status.heartbeatAgeMs ?? 0;
      const staleThreshold = 5 * 60 * 1000; // 5 minutes
      let agentStatus: AgentState["status"] = "idle";
      if (status.enabled && status.running) agentStatus = "running";
      else if (status.enabled) agentStatus = "idle";
      if (status.enabled && heartbeatAge > staleThreshold) agentStatus = "error";
      return {
        status: agentStatus,
        metrics: {
          enabled: status.enabled,
          running: status.running,
          cycle: status.cycle,
          heartbeat: status.heartbeat,
          heartbeatAgeMs: heartbeatAge,
        },
      };
    } catch (err) {
      return { status: "unknown", metrics: {}, message: (err as Error).message };
    }
  }
}

@Injectable()
export class EngagementMetricsCollector implements IMetricsCollector {
  public readonly id = "engagement";

  constructor(private readonly prisma: PrismaService) {}

  async collect(): Promise<AgentState> {
    try {
      const [total, completed, failed, byTypeRaw, browsing] = await Promise.all([
        this.prisma.interaction.count(),
        this.prisma.interaction.count({ where: { status: InteractionStatus.COMPLETED } }),
        this.prisma.interaction.count({ where: { status: InteractionStatus.FAILED } }),
        this.prisma.interaction.groupBy({ by: ["type"], _count: true }),
        this.prisma.browsingSession.groupBy({ by: ["status"], _count: true }),
      ]);

      const byType: Record<string, number> = {};
      for (const item of byTypeRaw) {
        byType[item.type] = item._count;
      }

      const activeBrowsing =
        browsing.find((b) => b.status === BrowsingSessionStatus.ACTIVE)?._count ?? 0;
      const status = activeBrowsing > 0 ? "running" : total > 0 ? "idle" : "disabled";

      return {
        status,
        metrics: {
          total,
          completed,
          failed,
          byType,
          activeBrowsing,
        },
      };
    } catch (err) {
      return { status: "unknown", metrics: {}, message: (err as Error).message };
    }
  }
}

@Injectable()
export class RepliesMetricsCollector implements IMetricsCollector {
  public readonly id = "replies";

  constructor(private readonly prisma: PrismaService) {}

  async collect(): Promise<AgentState> {
    try {
      const [newCount, replied, skipped, humanReview, repliedManual] = await Promise.all(
        Object.values(CommentStatus).map((status) =>
          this.prisma.incomingComment.count({ where: { status } }),
        ),
      );
      const statuses = Object.values(CommentStatus);
      const counts: Record<string, number> = {};
      const results = [newCount, replied, skipped, humanReview, repliedManual];
      statuses.forEach((s, i) => {
        counts[s] = results[i] ?? 0;
      });

      const total = Object.values(counts).reduce((a, b) => a + b, 0);
      return {
        status: total > 0 ? "running" : "disabled",
        metrics: { total, counts, humanReview },
      };
    } catch (err) {
      return { status: "unknown", metrics: {}, message: (err as Error).message };
    }
  }
}

@Injectable()
export class GenerationMetricsCollector implements IMetricsCollector {
  public readonly id = "generation";

  constructor(private readonly prisma: PrismaService) {}

  async collect(): Promise<AgentState> {
    try {
      const [total, running, completed, failed] = await Promise.all([
        this.prisma.generationRun.count(),
        this.prisma.generationRun.count({ where: { status: "RUNNING" } }),
        this.prisma.generationRun.count({ where: { status: "COMPLETED" } }),
        this.prisma.generationRun.count({ where: { status: "FAILED" } }),
      ]);
      const status =
        running > 0 ? "running" : failed > 0 ? "warning" : total > 0 ? "idle" : "disabled";
      return {
        status,
        metrics: { total, running, completed, failed },
      };
    } catch (err) {
      return { status: "unknown", metrics: {}, message: (err as Error).message };
    }
  }
}

@Injectable()
export class PostingMetricsCollector implements IMetricsCollector {
  public readonly id = "posting";

  constructor(private readonly prisma: PrismaService) {}

  async collect(): Promise<AgentState> {
    try {
      const [approved, posting, failed, completed] = await Promise.all([
        this.prisma.post.count({ where: { status: "APPROVED" } }),
        this.prisma.post.count({ where: { status: "POSTING" } }),
        this.prisma.post.count({ where: { status: "FAILED" } }),
        this.prisma.post.count({ where: { status: "POSTED" } }),
      ]);
      const status =
        posting > 0 ? "running" : failed > 0 ? "error" : approved > 0 ? "warning" : "idle";
      return {
        status,
        metrics: { approved, posting, failed, completed },
      };
    } catch (err) {
      return { status: "unknown", metrics: {}, message: (err as Error).message };
    }
  }
}
