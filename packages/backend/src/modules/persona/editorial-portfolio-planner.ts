import { Injectable } from "@nestjs/common";
import type { ExecutionMode } from "../policy/policy.types.js";

export type EditorialAssignmentAction = "OWN_POST" | "REPLY" | "QUOTE" | "DEFER" | "SKIP";

export interface EditorialOpportunityInput {
  readonly opportunityId: string;
  readonly canonicalTopic: string;
  readonly thesis: string;
  readonly thesisHash: string;
  readonly domain: string;
  readonly riskTier: "LOW" | "MEDIUM" | "HIGH";
  readonly funnelIntent: string;
  readonly validUntil: Date;
  readonly status?: "OPEN" | "EXPIRED" | "CLOSED";
}

export interface EditorialAccountCandidate {
  readonly accountId: string;
  readonly personaRevisionId: string;
  readonly network: string;
  readonly voiceMode: string;
  readonly policyMode: ExecutionMode;
  readonly healthy: boolean;
  readonly allowedActions: readonly EditorialAssignmentAction[];
  readonly personaFit: number;
  readonly audienceDemand: number;
  readonly sourceFreshness: number;
  readonly novelty: number;
  readonly pillarDeficit: number;
  readonly funnelDeficit: number;
  readonly conversationOpportunity: number;
  readonly expectedCost: number;
  readonly reviewCapacity: number;
}

export interface EditorialAssignment {
  readonly opportunityId: string;
  readonly accountId: string | null;
  readonly personaRevisionId: string | null;
  readonly action: EditorialAssignmentAction;
  readonly thesis: string;
  readonly thesisHash: string;
  readonly angle: string;
  readonly voiceMode: string | null;
  readonly funnelIntent: string;
  readonly scoreComponents: Readonly<Record<string, number>>;
  readonly hardConstraintResults: readonly { name: string; passed: boolean; reason: string }[];
  readonly validUntil: string;
}

@Injectable()
export class EditorialPortfolioPlanner {
  plan(
    opportunities: readonly EditorialOpportunityInput[],
    candidates: readonly EditorialAccountCandidate[],
    existingThesisHashes: ReadonlySet<string> = new Set(),
  ): EditorialAssignment[] {
    const assignedTheses = new Set(existingThesisHashes);

    return opportunities.map((opportunity) => {
      const baseConstraints = [
        {
          name: "opportunity_open",
          passed: opportunity.status !== "EXPIRED" && opportunity.status !== "CLOSED",
          reason: "Opportunity must be open",
        },
        {
          name: "valid_until",
          passed: opportunity.validUntil > new Date(),
          reason: "Opportunity must not be expired",
        },
        {
          name: "thesis_not_saturated",
          passed: !assignedTheses.has(opportunity.thesisHash),
          reason: "Thesis is inside the cooldown/saturation set",
        },
      ];
      if (baseConstraints.some((constraint) => !constraint.passed)) {
        const action = baseConstraints[0]?.passed && baseConstraints[1]?.passed ? "SKIP" : "DEFER";
        return emptyAssignment(opportunity, action, baseConstraints);
      }

      const eligible = candidates.filter((candidate) => {
        if (!candidate.healthy || candidate.policyMode === "DISABLED") return false;
        if (opportunity.riskTier === "HIGH" && candidate.reviewCapacity <= 0) return false;
        return candidate.allowedActions.some((action) => action !== "SKIP" && action !== "DEFER");
      });
      if (eligible.length === 0) {
        return emptyAssignment(opportunity, "DEFER", [
          ...baseConstraints,
          {
            name: "eligible_account",
            passed: false,
            reason: "No healthy policy-eligible account has capacity",
          },
        ]);
      }

      const ranked = [...eligible].sort((left, right) => {
        const scoreDifference = scoreCandidate(right) - scoreCandidate(left);
        return scoreDifference || left.accountId.localeCompare(right.accountId);
      });
      const selected = ranked[0]!;
      const action = pickAction(selected, opportunity);
      assignedTheses.add(opportunity.thesisHash);
      return {
        opportunityId: opportunity.opportunityId,
        accountId: selected.accountId,
        personaRevisionId: selected.personaRevisionId,
        action,
        thesis: opportunity.thesis,
        thesisHash: opportunity.thesisHash,
        angle: `${opportunity.domain}:${opportunity.canonicalTopic}`,
        voiceMode: selected.voiceMode,
        funnelIntent: opportunity.funnelIntent,
        scoreComponents: scoreComponents(selected),
        hardConstraintResults: [
          ...baseConstraints,
          {
            name: "eligible_account",
            passed: true,
            reason: "Selected account is healthy and policy-eligible",
          },
          {
            name: "high_risk_review_capacity",
            passed: opportunity.riskTier !== "HIGH" || selected.reviewCapacity > 0,
            reason: "High-risk opportunities require review capacity",
          },
        ],
        validUntil: opportunity.validUntil.toISOString(),
      };
    });
  }
}

function scoreCandidate(candidate: EditorialAccountCandidate): number {
  const components = scoreComponents(candidate);
  return Object.values(components).reduce((sum, value) => sum + value, 0);
}

function scoreComponents(candidate: EditorialAccountCandidate): Record<string, number> {
  return {
    personaFit: clamp(candidate.personaFit),
    audienceDemand: clamp(candidate.audienceDemand),
    sourceFreshness: clamp(candidate.sourceFreshness),
    novelty: clamp(candidate.novelty),
    pillarDeficit: clamp(candidate.pillarDeficit),
    funnelDeficit: clamp(candidate.funnelDeficit),
    conversationOpportunity: clamp(candidate.conversationOpportunity),
    reviewCapacity: clamp(candidate.reviewCapacity),
    costEfficiency: 1 - clamp(candidate.expectedCost),
  };
}

function pickAction(
  candidate: EditorialAccountCandidate,
  opportunity: EditorialOpportunityInput,
): Exclude<EditorialAssignmentAction, "DEFER" | "SKIP"> {
  const preferred =
    opportunity.riskTier === "HIGH"
      ? ["REPLY", "QUOTE", "OWN_POST"]
      : ["OWN_POST", "REPLY", "QUOTE"];
  return (
    (preferred.find((action) =>
      candidate.allowedActions.includes(action as EditorialAssignmentAction),
    ) as Exclude<EditorialAssignmentAction, "DEFER" | "SKIP"> | undefined) ?? "OWN_POST"
  );
}

function emptyAssignment(
  opportunity: EditorialOpportunityInput,
  action: "DEFER" | "SKIP",
  constraints: readonly { name: string; passed: boolean; reason: string }[],
): EditorialAssignment {
  return {
    opportunityId: opportunity.opportunityId,
    accountId: null,
    personaRevisionId: null,
    action,
    thesis: opportunity.thesis,
    thesisHash: opportunity.thesisHash,
    angle: "",
    voiceMode: null,
    funnelIntent: opportunity.funnelIntent,
    scoreComponents: {},
    hardConstraintResults: constraints,
    validUntil: opportunity.validUntil.toISOString(),
  };
}

function clamp(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0;
}
