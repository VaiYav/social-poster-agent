import { Injectable } from "@nestjs/common";
import type { SocialNetwork } from "../../generated/prisma/client.js";
import { EngagementSafetyService } from "./engagement-safety.service.js";

export type CandidateDecision =
  | "SKIP"
  | "READ"
  | "LIKE_ELIGIBLE"
  | "SUGGEST_REPLY"
  | "SUGGEST_QUOTE";

export interface EngagementCandidateInput {
  readonly network: SocialNetwork;
  readonly postUrl: string;
  readonly postText: string;
  readonly topicKeywords?: readonly string[];
  readonly authorHandle?: string;
  readonly source: string;
  readonly previousTexts?: readonly string[];
}

export interface EngagementCandidateScore {
  readonly topicFit: number;
  readonly personaFit: number;
  readonly conversationInvitation: number;
  readonly novelValuePotential: number;
  readonly relationshipContinuity: number;
  readonly duplicationRisk: number;
  readonly safetyRisk: number;
  readonly policyEligible: boolean;
  readonly decision: CandidateDecision;
  readonly reasons: readonly string[];
}

@Injectable()
export class EngagementCandidateScorer {
  constructor(private readonly safety: EngagementSafetyService) {}

  score(input: EngagementCandidateInput): EngagementCandidateScore {
    const text = input.postText.trim();
    const reasons: string[] = [];
    if (!text) return skipped("Empty public post");

    const safetyResult = this.safety.checkContentSafety(text);
    if (!safetyResult.safe) {
      return {
        ...skipped(safetyResult.reason ?? "Safety gate rejected candidate"),
        safetyRisk: 1,
      };
    }

    const normalized = normalize(text);
    const duplicate = input.previousTexts?.some((previous) => normalize(previous) === normalized);
    const duplicationRisk = duplicate ? 1 : 0;
    if (duplicate) return skipped("Duplicate candidate text", { duplicationRisk });

    const keywordHits = (input.topicKeywords ?? []).filter((keyword) =>
      normalized.includes(normalize(keyword)),
    ).length;
    const topicFit = input.topicKeywords?.length
      ? Math.min(1, keywordHits / Math.min(3, input.topicKeywords.length))
      : 0.5;
    const conversationInvitation = /\?\s*$/.test(text)
      ? 0.9
      : /\b(why|how|when|anyone)\b/i.test(text)
        ? 0.55
        : 0.2;
    const novelValuePotential =
      text.length >= 80 && !/^nice|great post|love this[.!]?$/i.test(text) ? 0.75 : 0.25;
    const relationshipContinuity = input.source === "notifications" ? 0.8 : 0.35;
    const personaFit = input.authorHandle ? 0.6 : 0.4;
    const safetyRisk = 0;
    const policyEligible = true;

    if (topicFit < 0.25 || novelValuePotential < 0.4) {
      return {
        topicFit,
        personaFit,
        conversationInvitation,
        novelValuePotential,
        relationshipContinuity,
        duplicationRisk,
        safetyRisk,
        policyEligible,
        decision: "SKIP",
        reasons: ["Insufficient topic fit or novel value"],
      };
    }

    if (conversationInvitation >= 0.55 || relationshipContinuity >= 0.75) {
      reasons.push("Public conversation has a specific invitation or continuity signal");
      return {
        topicFit,
        personaFit,
        conversationInvitation,
        novelValuePotential,
        relationshipContinuity,
        duplicationRisk,
        safetyRisk,
        policyEligible,
        decision: "SUGGEST_REPLY",
        reasons,
      };
    }

    return {
      topicFit,
      personaFit,
      conversationInvitation,
      novelValuePotential,
      relationshipContinuity,
      duplicationRisk,
      safetyRisk,
      policyEligible,
      decision: "LIKE_ELIGIBLE",
      reasons: ["Candidate passes deterministic relevance/value gate"],
    };
  }
}

function skipped(
  reason: string,
  overrides: Partial<EngagementCandidateScore> = {},
): EngagementCandidateScore {
  return {
    topicFit: 0,
    personaFit: 0,
    conversationInvitation: 0,
    novelValuePotential: 0,
    relationshipContinuity: 0,
    duplicationRisk: 0,
    safetyRisk: 1,
    policyEligible: false,
    decision: "SKIP",
    reasons: [reason],
    ...overrides,
  };
}

function normalize(value: string): string {
  return value.toLowerCase().replace(/\s+/g, " ").trim();
}
