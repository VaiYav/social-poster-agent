// Sprint K: Selector health monitoring — tracks selector success/failure rates
// and alerts when selectors become unreliable (UI changes on social networks).
//
// Tracks per-selector stats:
//   - total attempts
//   - successes
//   - failures
//   - last success timestamp
//   - last failure timestamp
//   - current health status: HEALTHY / DEGRADED / BROKEN
//
// Health thresholds:
//   HEALTHY:   success rate ≥ 90%
//   DEGRADED:  success rate 50-89%
//   BROKEN:    success rate < 50%
//
// When a selector becomes DEGRADED or BROKEN, a warning is logged and an SSE
// event is published so the UI can alert the operator.

import { Injectable, Logger } from '@nestjs/common';
import type { SocialNetwork } from '@prisma/client';

export type SelectorHealthStatus = 'HEALTHY' | 'DEGRADED' | 'BROKEN';

export interface SelectorStats {
  selectorKey: string;
  network: SocialNetwork;
  totalAttempts: number;
  successes: number;
  failures: number;
  lastSuccessAt: Date | null;
  lastFailureAt: Date | null;
  status: SelectorHealthStatus;
}

interface SelectorRecord {
  totalAttempts: number;
  successes: number;
  failures: number;
  lastSuccessAt: Date | null;
  lastFailureAt: Date | null;
}

const HEALTHY_THRESHOLD = 0.9;
const DEGRADED_THRESHOLD = 0.5;

@Injectable()
export class SelectorHealthService {
  private readonly logger = new Logger(SelectorHealthService.name);
  private readonly records = new Map<string, SelectorRecord>();
  private alertCallback?: (alert: {
    selectorKey: string;
    network: SocialNetwork;
    status: SelectorHealthStatus;
    successRate: number;
  }) => void;

  /** Set a callback to be invoked when a selector's health status changes. */
  setAlertCallback(
    cb: (alert: {
      selectorKey: string;
      network: SocialNetwork;
      status: SelectorHealthStatus;
      successRate: number;
    }) => void,
  ): void {
    this.alertCallback = cb;
  }

  /** Build a composite key: network:selectorKey */
  private key(network: SocialNetwork, selectorKey: string): string {
    return `${network}:${selectorKey}`;
  }

  /** Record a successful selector resolution. */
  recordSuccess(network: SocialNetwork, selectorKey: string): void {
    const k = this.key(network, selectorKey);
    const record = this.records.get(k) ?? {
      totalAttempts: 0,
      successes: 0,
      failures: 0,
      lastSuccessAt: null,
      lastFailureAt: null,
    };
    // Compute prevStatus BEFORE incrementing — otherwise it always equals
    // newStatus and recovery alerts (BROKEN→DEGRADED→HEALTHY) never fire.
    const prevStatus = this.computeStatus(record);
    record.totalAttempts++;
    record.successes++;
    record.lastSuccessAt = new Date();

    this.records.set(k, record);
    const newStatus = this.computeStatus(record);

    if (newStatus !== prevStatus && newStatus !== 'HEALTHY') {
      this.fireAlert(selectorKey, network, newStatus, record);
    }
  }

  /** Record a failed selector resolution. */
  recordFailure(network: SocialNetwork, selectorKey: string): void {
    const k = this.key(network, selectorKey);
    const record = this.records.get(k) ?? {
      totalAttempts: 0,
      successes: 0,
      failures: 0,
      lastSuccessAt: null,
      lastFailureAt: null,
    };
    const prevStatus = this.computeStatus(record);
    record.totalAttempts++;
    record.failures++;
    record.lastFailureAt = new Date();
    this.records.set(k, record);
    const newStatus = this.computeStatus(record);

    if (newStatus !== prevStatus && newStatus !== 'HEALTHY') {
      this.fireAlert(selectorKey, network, newStatus, record);
    }

    this.logger.warn(
      `Selector "${selectorKey}" for ${network} failed (${record.failures}/${record.totalAttempts} attempts, status: ${newStatus})`,
    );
  }

  /** Get the current health status of a selector. */
  getStatus(network: SocialNetwork, selectorKey: string): SelectorHealthStatus {
    const record = this.records.get(this.key(network, selectorKey));
    if (!record) return 'HEALTHY';
    return this.computeStatus(record);
  }

  /** Get stats for all tracked selectors. */
  getAllStats(): SelectorStats[] {
    const stats: SelectorStats[] = [];
    for (const [k, record] of this.records) {
      const [network, selectorKey] = k.split(':') as [SocialNetwork, string];
      stats.push({
        selectorKey,
        network,
        totalAttempts: record.totalAttempts,
        successes: record.successes,
        failures: record.failures,
        lastSuccessAt: record.lastSuccessAt,
        lastFailureAt: record.lastFailureAt,
        status: this.computeStatus(record),
      });
    }
    return stats;
  }

  /** Get stats for a specific network. */
  getStatsForNetwork(network: SocialNetwork): SelectorStats[] {
    return this.getAllStats().filter((s) => s.network === network);
  }

  /** Get all selectors that are DEGRADED or BROKEN. */
  getUnhealthySelectors(): SelectorStats[] {
    return this.getAllStats().filter((s) => s.status !== 'HEALTHY');
  }

  /** Reset all stats (useful for testing). */
  reset(): void {
    this.records.clear();
  }

  // ── Internal helpers ──────────────────────────────────────────

  private computeStatus(record: SelectorRecord): SelectorHealthStatus {
    if (record.totalAttempts < 5) return 'HEALTHY'; // Not enough data
    const successRate = record.successes / record.totalAttempts;
    if (successRate >= HEALTHY_THRESHOLD) return 'HEALTHY';
    if (successRate >= DEGRADED_THRESHOLD) return 'DEGRADED';
    return 'BROKEN';
  }

  private fireAlert(
    selectorKey: string,
    network: SocialNetwork,
    status: SelectorHealthStatus,
    record: SelectorRecord,
  ): void {
    const successRate = record.totalAttempts > 0 ? record.successes / record.totalAttempts : 0;
    this.logger.warn(
      `Selector health alert: "${selectorKey}" for ${network} is now ${status} (success rate: ${(successRate * 100).toFixed(1)}%)`,
    );
    if (this.alertCallback) {
      try {
        this.alertCallback({ selectorKey, network, status, successRate });
      } catch {
        // Alert callback failure should never break posting
      }
    }
  }
}
