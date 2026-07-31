import { Injectable, Logger } from '@nestjs/common';
import { SocialNetwork } from '@prisma/client';
import { getEnabledNetworks } from '../../domain/enabled-networks.js';
import type { SessionState, WorldState } from './types.js';

/**
 * NetworkSelector — centralized network-selection logic.
 *
 * Consolidates the duplicated readiness/scoring logic that previously lived
 * in both GuardrailsService and DecisionEngineService.rulesOnlyDecision().
 * Selection is deterministic, priority-free, and stateless.
 */

export interface NetworkReadinessOptions {
  /** Require an ACTIVE session. */
  requireActive?: boolean;
  /** Skip networks with an open or half-open circuit breaker. */
  requireNoCircuitRisk?: boolean;
  /** Require daily/weekly rate-limit capacity. */
  requireRateLimit?: boolean;
  /** Enforce a maximum queue depth. */
  requireQueueDepth?: boolean;
  maxQueueDepth?: number;
  /** Require the network to be in a posting window. */
  requireInPostingWindow?: boolean;
  /** Require at least one approved draft on this network. */
  requireApprovedByNetwork?: boolean;
}

@Injectable()
export class NetworkSelector {
  private readonly logger = new Logger(NetworkSelector.name);

  isCircuitBreakerRisky(circuitBreaker: SessionState['circuitBreaker'] | undefined): boolean {
    return circuitBreaker === 'open' || circuitBreaker === 'half_open';
  }

  /**
   * Check whether a network has daily/weekly rate-limit capacity.
   * A limit of 0 means unlimited.
   */
  hasRateLimitCapacity(network: SocialNetwork, world: WorldState): boolean {
    const rl = world.rateLimits[network];
    if (!rl) return false;
    const dailyReady = rl.dailyLimit > 0 ? rl.dailyRemaining > 0 : true;
    const weeklyReady = rl.weeklyLimit > 0 ? rl.weeklyRemaining > 0 : true;
    return dailyReady && weeklyReady;
  }

  /**
   * Low-level readiness predicate.
   */
  isReady(network: SocialNetwork, world: WorldState, options: NetworkReadinessOptions = {}): boolean {
    const session = world.sessions[network];

    if (options.requireActive && session?.status !== 'ACTIVE') return false;
    if (options.requireNoCircuitRisk && this.isCircuitBreakerRisky(session?.circuitBreaker)) return false;

    if (options.requireRateLimit && !this.hasRateLimitCapacity(network, world)) return false;

    if (options.requireQueueDepth) {
      const max = options.maxQueueDepth ?? 5;
      if ((world.queueDepth[network] ?? 0) > max) return false;
    }

    if (options.requireInPostingWindow && !world.inPostingWindow[network]) return false;
    if (options.requireApprovedByNetwork && (world.drafts.approvedByNetwork[network] ?? 0) <= 0) return false;

    return true;
  }

  /** Is the network healthy enough to be a generation target? */
  isReadyForGeneration(network: SocialNetwork, world: WorldState): boolean {
    return this.isReady(network, world, {
      requireActive: true,
      requireNoCircuitRisk: true,
      requireRateLimit: true,
      requireQueueDepth: true,
      maxQueueDepth: 5,
    });
  }

  /** Is the network ready to post (approved drafts, in window, rate limits, etc)? */
  isReadyForPost(network: SocialNetwork, world: WorldState, requireApprovedByNetwork = true): boolean {
    return this.isReady(network, world, {
      requireActive: true,
      requireNoCircuitRisk: true,
      requireRateLimit: true,
      requireQueueDepth: true,
      maxQueueDepth: 5,
      requireInPostingWindow: true,
      requireApprovedByNetwork,
    });
  }

  /** Is the network healthy enough for an engagement session? */
  isReadyForEngagement(network: SocialNetwork, world: WorldState): boolean {
    return this.isReady(network, world, {
      requireActive: true,
      requireNoCircuitRisk: true,
    });
  }

  /**
   * Select the best generation network: healthy, active, with capacity,
   * and the oldest lastPostMs.
   */
  selectBestGenerationNetwork(world: WorldState): SocialNetwork | undefined {
    if (world.flowControl.pauseGeneration) return undefined;
    return this.selectBestByScore(world, (net) => this.isReadyForGeneration(net, world), (net) => world.rateLimits[net]?.lastPostMs ?? 0, 'min');
  }

  /**
   * Select the best ready-to-post network.
   */
  selectBestReadyNetwork(world: WorldState, requireApprovedByNetwork = true): SocialNetwork | undefined {
    if (world.flowControl.pausePosting) return undefined;

    const networks = getEnabledNetworks();
    const readyDebug = networks.map((net) => ({
      net,
      inWindow: world.inPostingWindow[net],
      dailyRemaining: world.rateLimits[net]?.dailyRemaining ?? 0,
      weeklyRemaining: world.rateLimits[net]?.weeklyRemaining ?? 0,
      status: world.sessions[net]?.status,
      circuitBreaker: world.sessions[net]?.circuitBreaker,
      lastPostMs: world.rateLimits[net]?.lastPostMs ?? 0,
      approved: world.drafts.approvedByNetwork[net] ?? 0,
    }));
    this.logger.debug(`Ready networks: ${JSON.stringify(readyDebug)}`);

    return this.selectBestByScore(
      world,
      (net) => this.isReadyForPost(net, world, requireApprovedByNetwork),
      (net) => world.rateLimits[net]?.lastPostMs ?? 0,
      'min',
    );
  }

  /**
   * Select the best engagement network: active, no circuit risk, oldest lastBrowseMs.
   * Optionally only consider networks whose lastBrowseMs is before `maxLastBrowseMs`.
   */
  selectBestEngagementNetwork(world: WorldState, maxLastBrowseMs?: number): SocialNetwork | undefined {
    if (world.flowControl.pauseEngagement) return undefined;
    return this.selectBestByScore(
      world,
      (net) => {
        if (!this.isReadyForEngagement(net, world)) return false;
        if (maxLastBrowseMs !== undefined && (world.engagement.lastBrowseMs[net] ?? 0) >= maxLastBrowseMs) return false;
        return true;
      },
      (net) => world.engagement.lastBrowseMs[net] ?? 0,
      'min',
    );
  }

  private selectBestByScore(
    world: WorldState,
    predicate: (network: SocialNetwork) => boolean,
    score: (network: SocialNetwork) => number,
    order: 'min' | 'max',
  ): SocialNetwork | undefined {
    const networks = getEnabledNetworks();
    let chosen: SocialNetwork | undefined;
    let chosenScore = order === 'min' ? Infinity : -Infinity;

    for (const net of networks) {
      if (!predicate(net)) continue;
      const s = score(net);
      const better = order === 'min' ? s < chosenScore : s > chosenScore;
      if (better) {
        chosen = net;
        chosenScore = s;
      }
    }
    return chosen;
  }
}
