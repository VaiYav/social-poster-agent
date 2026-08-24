import { Injectable, Logger } from "@nestjs/common";
import { SocialNetwork } from "../../generated/prisma/client.js";
import { NetworkSelector } from "./network-selector.js";
import type { WorldState, Action } from "./types.js";
import { WAIT_ACTION } from "./types.js";

interface Rule {
  readonly priority: number;
  evaluate(world: WorldState): Action | null;
}

const FOUR_HOURS_MS = 4 * 60 * 60 * 1000;
const TWO_HOURS_MS = 2 * 60 * 60 * 1000;

/**
 * RulesEngine — deterministic rules-only fallback decision logic.
 *
 * Replaces the monolithic DecisionEngineService.rulesOnlyDecision() with a set of
 * prioritized, independent rule classes. The first rule that returns an Action wins;
 * if none fire, the engine returns a WAIT action.
 */

class TopicPoolRule implements Rule {
  readonly priority = 10;

  evaluate(world: WorldState): Action | null {
    if (world.topicPool.count < world.topicPool.threshold) {
      return {
        type: "GENERATE_TOPICS",
        reason: `Topic pool ${world.topicPool.count}/${world.topicPool.threshold}`,
        source: "rules_fallback",
      };
    }
    return null;
  }
}

class PostApprovedRule implements Rule {
  readonly priority = 20;

  constructor(private readonly networkSelector: NetworkSelector) {}

  evaluate(world: WorldState): Action | null {
    if (world.drafts.approved <= 0) return null;

    // Try to post the best ready network.
    const postNet = this.networkSelector.selectBestReadyNetwork(world, true);
    if (postNet) {
      return {
        type: "POST",
        network: postNet,
        reason: `${world.drafts.approved} approved drafts, ${postNet} in posting window`,
        source: "rules_fallback",
      };
    }

    // No ready post network — try to generate drafts for a healthy alternative.
    const genNet = this.networkSelector.selectBestGenerationNetwork(world);
    if (genNet) {
      return {
        type: "GENERATE_POSTS",
        network: genNet,
        reason: `Approved drafts but no healthy POST network; generating drafts for ${genNet}`,
        source: "rules_fallback",
      };
    }

    return WAIT_ACTION(
      "Approved drafts waiting for healthy posting network",
      120_000,
      "rules_fallback",
    );
  }
}

class EngagementBrowseRule implements Rule {
  readonly priority = 30;

  constructor(private readonly networkSelector: NetworkSelector) {}

  evaluate(world: WorldState): Action | null {
    if (world.drafts.approved > 0 || world.topicPool.count < world.topicPool.threshold) return null;
    if (world.engagement.engagementDebt <= 0) return null;

    const fourHoursAgo = Date.now() - FOUR_HOURS_MS;
    const browseNet = this.networkSelector.selectBestEngagementNetwork(world, fourHoursAgo);
    if (browseNet) {
      return {
        type: "BROWSE",
        network: browseNet,
        reason: `Engagement-first: ${world.engagement.engagementDebt} network(s) need browsing, ${browseNet} is stale`,
        source: "rules_fallback",
      };
    }
    return null;
  }
}

class GeneratePostsRule implements Rule {
  readonly priority = 40;

  constructor(private readonly networkSelector: NetworkSelector) {}

  evaluate(world: WorldState): Action | null {
    if (world.topicPool.count < world.topicPool.threshold || world.drafts.approved > 0) return null;

    const genNet = this.networkSelector.selectBestGenerationNetwork(world);
    if (genNet) {
      return {
        type: "GENERATE_POSTS",
        network: genNet,
        reason: `No approved drafts; generating for ${genNet}`,
        source: "rules_fallback",
      };
    }

    // Do not terminate the rules chain here. A missing generation network must
    // not starve higher-value maintenance rules (reply checks, DLQ triage and
    // stale-trend refresh). WaitRule remains the final fallback when none of
    // those rules has actionable work.
    return null;
  }
}

class CheckRepliesRule implements Rule {
  readonly priority = 50;

  evaluate(world: WorldState): Action | null {
    if (world.engagement.uncheckedReplies > 0) {
      return {
        type: "CHECK_REPLIES",
        reason: `${world.engagement.uncheckedReplies} unchecked replies`,
        source: "rules_fallback",
      };
    }
    return null;
  }
}

class TriageQueueRule implements Rule {
  readonly priority = 60;

  evaluate(world: WorldState): Action | null {
    if (world.health.dlqDepth > 0) {
      return {
        type: "TRIAGE_QUEUE",
        reason: `${world.health.dlqDepth} failed job(s) in posting DLQ`,
        source: "rules_fallback",
      };
    }
    return null;
  }
}

class RefreshTrendsRule implements Rule {
  readonly priority = 70;

  evaluate(world: WorldState): Action | null {
    const twoHoursAgo = Date.now() - TWO_HOURS_MS;
    if (world.trends.lastRefreshMs < twoHoursAgo) {
      return {
        type: "REFRESH_TRENDS",
        reason: "Trends cache stale (> 2h)",
        source: "rules_fallback",
      };
    }
    return null;
  }
}

class WaitRule implements Rule {
  readonly priority = 100;

  evaluate(): Action {
    return WAIT_ACTION("No actionable condition", 120_000, "rules_fallback");
  }
}

@Injectable()
export class RulesEngine {
  private readonly logger = new Logger(RulesEngine.name);
  private readonly rules: Rule[];

  constructor(private readonly networkSelector: NetworkSelector) {
    this.rules = [
      new TopicPoolRule(),
      new PostApprovedRule(networkSelector),
      new EngagementBrowseRule(networkSelector),
      new GeneratePostsRule(networkSelector),
      new CheckRepliesRule(),
      new TriageQueueRule(),
      new RefreshTrendsRule(),
      new WaitRule(),
    ];
  }

  /**
   * Run rules in priority order and return the first non-null action.
   * Always returns an Action (the WaitRule is the final fallback).
   */
  decide(world: WorldState): Action {
    const sorted = [...this.rules].sort((a, b) => a.priority - b.priority);
    for (const rule of sorted) {
      const action = rule.evaluate(world);
      if (action) {
        this.logger.debug(
          `Rule ${rule.constructor.name} → ${action.type}${action.network ? `:${action.network}` : ""}`,
        );
        return action;
      }
    }
    // Should never happen because WaitRule always returns an action.
    return WAIT_ACTION("No actionable condition", 120_000, "rules_fallback");
  }
}
