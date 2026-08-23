import { Injectable, Logger, Optional } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import * as Sentry from "@sentry/nestjs";
import { DiscordNotificationService } from "../../infrastructure/notifications/discord-notification.service.js";
import type { SocialNetwork } from "../../generated/prisma/client.js";

export type OnlineCheck = {
  name: string;
  passed: boolean;
  reason: string;
};

export type SemanticEvaluation = {
  passed: boolean;
  score?: number;
  reason?: string;
};

export interface OnlineEvaluationInput {
  postId?: string;
  content: string;
  network: SocialNetwork;
  maxCharacters?: number;
  taskCompleted?: boolean;
  provider?: string;
  model?: string;
  promptManaged?: boolean;
  promptLinked?: boolean;
  usageKnown?: boolean;
  costKnown?: boolean;
  fallbackDepth?: number;
  decision?: string;
  normalizedEditDistance?: number;
  hardFailure?: boolean;
  language?: string;
}

export interface OnlineEvaluationResult {
  observationId: string;
  deterministic: {
    passed: boolean;
    checks: OnlineCheck[];
  };
  semantic: {
    selected: boolean;
    forced: boolean;
    status: "NOT_SELECTED" | "PENDING" | "SCORED" | "UNAVAILABLE" | "FAILED";
    result?: SemanticEvaluation;
  };
}

export interface OnlineSloSnapshot {
  windowMs: number;
  sampleCount: number;
  deterministicPassRate: number | null;
  taskCompletionRate: number | null;
  unknownProviderRate: number | null;
  usageCostCoverage: number | null;
  promptLinkCoverage: number | null;
  fallbackDepthP95: number | null;
  semanticSampleCoverage: number | null;
}

export interface OnlineDashboardAlert {
  id: string;
  severity: "info";
  message: string;
  fields: string[];
  at: number;
}

/** Signals owned by other evidence-producing systems but routed through the same alert catalog. */
export interface OnlineExternalSloSignals {
  safetyHardGateFailure?: boolean;
  acceptedOutputCostUsd?: number;
  baselineAcceptedOutputCostUsd7d?: number;
  generationP95LatencyMs?: number;
  baselineGenerationP95LatencyMs7d?: number;
  feedbackSyncP95AgeMs?: number;
  feedbackSyncFailed?: number;
  humanQuality?: number;
  humanQualityBaseline?: number;
  humanReviewedSampleCount?: number;
  judgeKappa?: number | null;
  experimentHardGateRegression?: boolean;
}

type StoredObservation = OnlineEvaluationInput & {
  observedAt: number;
  deterministicPassed: boolean;
  semanticSelected: boolean;
};

type AlertSeverity = "warning" | "critical";

/**
 * Online EVAL-702 lane. Cheap deterministic checks run for every eligible
 * final output; semantic checks are sampled at 5% with force-inclusion rules.
 * This service intentionally keeps monitoring evidence separate from the
 * production approval gate and uses bounded in-memory windows until durable
 * online evaluator storage is approved.
 */
@Injectable()
export class OnlineEvaluationService {
  private readonly logger = new Logger(OnlineEvaluationService.name);
  private readonly semanticSampleRate: number;
  private readonly observationWindowMs: number;
  private readonly maxObservations: number;
  private readonly alertCooldownMs: number;
  private readonly observations: StoredObservation[] = [];
  private readonly lastAlerts = new Map<string, { at: number; fingerprint: string }>();
  private readonly dashboardAlerts: OnlineDashboardAlert[] = [];
  private sequence = 0;

  constructor(
    private readonly configService: ConfigService,
    @Optional() private readonly discord?: DiscordNotificationService,
  ) {
    this.semanticSampleRate = clamp(
      Number(this.configService.get<string>("ONLINE_EVAL_SEMANTIC_SAMPLE_RATE", "0.05")),
      0,
      1,
    );
    this.observationWindowMs = Math.max(
      60_000,
      Number(this.configService.get<string>("ONLINE_EVAL_WINDOW_MS", String(24 * 60 * 60 * 1000))),
    );
    this.maxObservations = Math.max(
      100,
      Number(this.configService.get<string>("ONLINE_EVAL_MAX_OBSERVATIONS", "10000")),
    );
    this.alertCooldownMs = Math.max(
      60_000,
      Number(this.configService.get<string>("ONLINE_EVAL_ALERT_COOLDOWN_MS", "1800000")),
    );
  }

  async evaluate(
    input: OnlineEvaluationInput,
    semanticJudge?: (input: OnlineEvaluationInput) => Promise<SemanticEvaluation>,
    random = Math.random,
  ): Promise<OnlineEvaluationResult> {
    const checks = deterministicChecks(input);
    const deterministicPassed = checks.every((check) => check.passed);
    const forced = isForceIncluded(input);
    const selected = forced || random() < this.semanticSampleRate;
    const observationId = `${Date.now()}-${++this.sequence}`;
    let semantic: OnlineEvaluationResult["semantic"] = {
      selected,
      forced,
      status: selected ? "PENDING" : "NOT_SELECTED",
    };

    if (selected && semanticJudge) {
      try {
        semantic = { ...semantic, status: "SCORED", result: await semanticJudge(input) };
      } catch (err) {
        semantic = { ...semantic, status: "FAILED" };
        this.logger.warn(
          `Online semantic evaluator failed for ${input.postId ?? observationId}: ${errorMessage(err)}`,
        );
      }
    } else if (selected) {
      semantic = { ...semantic, status: "UNAVAILABLE" };
    }

    this.observations.push({
      ...input,
      observedAt: Date.now(),
      deterministicPassed,
      semanticSelected: selected,
    });
    this.trimObservations(Date.now());

    if (!deterministicPassed && (input.hardFailure || !input.taskCompleted)) {
      await this.emitAlert(
        "EVAL-A02",
        "critical",
        `Online deterministic evaluator failed for ${input.postId ?? input.network}`,
        checks.filter((check) => !check.passed).map((check) => `${check.name}: ${check.reason}`),
      );
    }
    await this.evaluateSloAlerts();

    return { observationId, deterministic: { passed: deterministicPassed, checks }, semantic };
  }

  getSloSnapshot(now = Date.now()): OnlineSloSnapshot {
    this.trimObservations(now);
    const observations = this.observations;
    const sampleCount = observations.length;
    const completed = observations.filter((item) => item.taskCompleted !== false).length;
    const knownProvider = observations.filter((item) =>
      Boolean(item.provider && item.model),
    ).length;
    const knownUsage = observations.filter(
      (item) => item.usageKnown === true && item.costKnown === true,
    ).length;
    const managedPrompts = observations.filter((item) => item.promptManaged === true);
    const linkedPrompts = managedPrompts.filter((item) => item.promptLinked === true).length;
    const fallbackDepths = observations
      .map((item) => item.fallbackDepth)
      .filter((value): value is number => typeof value === "number" && Number.isFinite(value))
      .sort((a, b) => a - b);

    return {
      windowMs: this.observationWindowMs,
      sampleCount,
      deterministicPassRate: ratio(
        observations.filter((item) => item.deterministicPassed).length,
        sampleCount,
      ),
      taskCompletionRate: ratio(completed, sampleCount),
      unknownProviderRate: sampleCount > 0 ? 1 - knownProvider / sampleCount : null,
      usageCostCoverage: ratio(knownUsage, sampleCount),
      promptLinkCoverage: managedPrompts.length > 0 ? linkedPrompts / managedPrompts.length : null,
      fallbackDepthP95: percentile95(fallbackDepths),
      semanticSampleCoverage: ratio(
        observations.filter((item) => item.semanticSelected).length,
        sampleCount,
      ),
    };
  }

  /** Evaluate non-generation SLO signals without mutating the observation window. */
  async evaluateExternalSignals(signals: OnlineExternalSloSignals): Promise<void> {
    if (signals.safetyHardGateFailure) {
      await this.emitAlert("EVAL-A02", "critical", "Online safety/platform hard gate failed", [
        "action=disable_auto_approve",
      ]);
    }
    if (
      isPositiveFinite(signals.acceptedOutputCostUsd) &&
      isPositiveFinite(signals.baselineAcceptedOutputCostUsd7d) &&
      signals.acceptedOutputCostUsd > signals.baselineAcceptedOutputCostUsd7d * 2
    ) {
      await this.emitAlert("EVAL-A07", "warning", "Cost per accepted output exceeded 2x baseline", [
        `current=${signals.acceptedOutputCostUsd.toFixed(6)}`,
        `baseline=${signals.baselineAcceptedOutputCostUsd7d.toFixed(6)}`,
      ]);
    }
    if (
      isPositiveFinite(signals.generationP95LatencyMs) &&
      isPositiveFinite(signals.baselineGenerationP95LatencyMs7d) &&
      signals.generationP95LatencyMs > signals.baselineGenerationP95LatencyMs7d * 1.5
    ) {
      await this.emitAlert("EVAL-A08", "warning", "Generation p95 latency exceeded 1.5x baseline", [
        `current_ms=${signals.generationP95LatencyMs.toFixed(0)}`,
        `baseline_ms=${signals.baselineGenerationP95LatencyMs7d.toFixed(0)}`,
      ]);
    }
    if (
      (isPositiveFinite(signals.feedbackSyncP95AgeMs) && signals.feedbackSyncP95AgeMs >= 900_000) ||
      (signals.feedbackSyncFailed ?? 0) >= 10
    ) {
      await this.emitAlert("EVAL-A09", "warning", "Feedback score sync is stale or failing", [
        `p95_age_ms=${signals.feedbackSyncP95AgeMs ?? "unknown"}`,
        `failed=${signals.feedbackSyncFailed ?? 0}`,
      ]);
    }
    if (
      isFiniteNumber(signals.humanQuality) &&
      isFiniteNumber(signals.humanQualityBaseline) &&
      (signals.humanReviewedSampleCount ?? 0) >= 30 &&
      signals.humanQuality < signals.humanQualityBaseline - 0.05
    ) {
      await this.emitAlert(
        "EVAL-A10",
        "warning",
        "Human quality fell more than 5pp below baseline",
        [
          `quality=${signals.humanQuality.toFixed(3)}`,
          `baseline=${signals.humanQualityBaseline.toFixed(3)}`,
          `sample_count=${signals.humanReviewedSampleCount}`,
        ],
      );
    }
    if (isFiniteNumber(signals.judgeKappa) && signals.judgeKappa < 0.6) {
      this.emitDashboardAlert("EVAL-A11", "Judge-human Cohen kappa is below 0.60", [
        `kappa=${signals.judgeKappa.toFixed(3)}`,
      ]);
    }
    if (signals.experimentHardGateRegression) {
      await this.emitAlert(
        "EVAL-A12",
        "critical",
        "Evaluation experiment hard-gate regression detected",
        ["action=reject_candidate"],
      );
    }
  }

  /** A11 is intentionally dashboard-only until calibration evidence is trusted. */
  getDashboardAlerts(): OnlineDashboardAlert[] {
    return this.dashboardAlerts.map((alert) => ({ ...alert, fields: [...alert.fields] }));
  }

  private async evaluateSloAlerts(): Promise<void> {
    const snapshot = this.getSloSnapshot();
    if (snapshot.sampleCount >= 20 && (snapshot.taskCompletionRate ?? 1) < 0.95) {
      await this.emitAlert("EVAL-A03", "warning", "Online task completion below 95%", [
        `sample_count=${snapshot.sampleCount}`,
        `completion_rate=${formatRate(snapshot.taskCompletionRate)}`,
      ]);
    }
    if (snapshot.sampleCount >= 20 && (snapshot.unknownProviderRate ?? 0) > 0.01) {
      await this.emitAlert("EVAL-A05", "warning", "Unknown provider/model attribution above 1%", [
        `unknown_rate=${formatRate(snapshot.unknownProviderRate)}`,
      ]);
    }
    if (snapshot.sampleCount >= 20 && (snapshot.usageCostCoverage ?? 1) < 0.95) {
      await this.emitAlert("EVAL-A06", "warning", "Usage/cost telemetry coverage below 95%", [
        `coverage=${formatRate(snapshot.usageCostCoverage)}`,
      ]);
    }
    if (snapshot.sampleCount >= 20 && (snapshot.fallbackDepthP95 ?? 0) > 2) {
      await this.emitAlert("EVAL-A04", "warning", "Fallback depth p95 exceeded 2", [
        `p95=${snapshot.fallbackDepthP95}`,
      ]);
    }
    const recentFailures = this.observations.filter(
      (item) => item.observedAt >= Date.now() - 15 * 60 * 1000 && item.taskCompleted === false,
    ).length;
    if (recentFailures >= 3) {
      await this.emitAlert(
        "EVAL-A01",
        "critical",
        "At least three final task failures in 15 minutes",
        [`failures=${recentFailures}`],
      );
    }
  }

  private async emitAlert(
    id: string,
    severity: AlertSeverity,
    message: string,
    fields: string[],
  ): Promise<void> {
    const fingerprint = `${severity}:${message}:${fields.join("|")}`;
    const previous = this.lastAlerts.get(id);
    const now = Date.now();
    const withinCooldown = previous && now - previous.at < this.alertCooldownMs;
    // Warnings dedupe by alert identity for the full cooldown. Critical state
    // changes may bypass it once when their fingerprint changes.
    if (withinCooldown && (severity !== "critical" || previous.fingerprint === fingerprint)) {
      return;
    }
    this.lastAlerts.set(id, { at: now, fingerprint });

    const fieldValues = fields.map((value, index) => ({ name: `metric_${index + 1}`, value }));
    if (severity === "critical")
      await this.discord?.critical(`[${id}] ${message}`, message, fieldValues);
    else await this.discord?.warning(`[${id}] ${message}`, message, fieldValues);
    Sentry.captureMessage(message, {
      level: severity === "critical" ? "error" : "warning",
      tags: { evaluator_alert_id: id },
      extra: { fields },
    });
  }

  private emitDashboardAlert(id: string, message: string, fields: string[]): void {
    const fingerprint = `info:${message}:${fields.join("|")}`;
    const previous = this.lastAlerts.get(`dashboard:${id}`);
    const now = Date.now();
    if (
      previous &&
      now - previous.at < this.alertCooldownMs &&
      previous.fingerprint === fingerprint
    ) {
      return;
    }
    this.lastAlerts.set(`dashboard:${id}`, { at: now, fingerprint });
    this.dashboardAlerts.push({ id, severity: "info", message, fields: [...fields], at: now });
    if (this.dashboardAlerts.length > 50) this.dashboardAlerts.shift();
  }

  private trimObservations(now: number): void {
    const cutoff = now - this.observationWindowMs;
    while (this.observations.length > 0 && this.observations[0]!.observedAt < cutoff) {
      this.observations.shift();
    }
    if (this.observations.length > this.maxObservations) {
      this.observations.splice(0, this.observations.length - this.maxObservations);
    }
  }
}

export function deterministicChecks(input: OnlineEvaluationInput): OnlineCheck[] {
  const contentLength = [...(input.content ?? "")].length;
  return [
    {
      name: "non_empty_content",
      passed: contentLength > 0,
      reason: contentLength > 0 ? "content present" : "final content is empty",
    },
    {
      name: "character_limit",
      passed: input.maxCharacters === undefined || contentLength <= input.maxCharacters,
      reason:
        input.maxCharacters === undefined || contentLength <= input.maxCharacters
          ? "within configured limit"
          : `${contentLength} > ${input.maxCharacters}`,
    },
    {
      name: "task_completed",
      passed: input.taskCompleted !== false,
      reason: input.taskCompleted === false ? "task reported failure" : "task completed",
    },
    {
      name: "provider_model_attributed",
      passed: Boolean(input.provider?.trim() && input.model?.trim()),
      reason: input.provider && input.model ? "provider/model present" : "provider/model unknown",
    },
    {
      name: "usage_cost_coverage",
      passed: input.usageKnown === true && input.costKnown === true,
      reason:
        input.usageKnown === true && input.costKnown === true
          ? "usage and cost are known"
          : "usage or cost is unknown",
    },
    {
      name: "prompt_linkage",
      passed: input.promptManaged !== true || input.promptLinked === true,
      reason:
        input.promptManaged !== true || input.promptLinked === true
          ? "managed prompt linkage is present or not applicable"
          : "managed prompt linkage is missing",
    },
  ];
}

function isForceIncluded(input: OnlineEvaluationInput): boolean {
  return Boolean(
    input.decision === "REJECT" ||
    (input.normalizedEditDistance !== undefined && input.normalizedEditDistance >= 0.05) ||
    input.hardFailure ||
    !input.provider ||
    !input.model ||
    (input.fallbackDepth !== undefined && input.fallbackDepth > 2),
  );
}

function percentile95(values: number[]): number | null {
  if (values.length === 0) return null;
  return values[Math.min(values.length - 1, Math.ceil(values.length * 0.95) - 1)] ?? null;
}

function ratio(numerator: number, denominator: number): number | null {
  return denominator > 0 ? numerator / denominator : null;
}

function clamp(value: number, min: number, max: number): number {
  return Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : min;
}

function formatRate(value: number | null): string {
  return value === null ? "null" : value.toFixed(3);
}

function isFiniteNumber(value: number | null | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isPositiveFinite(value: number | undefined): value is number {
  return isFiniteNumber(value) && value > 0;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
