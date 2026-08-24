import type { PersonaProfile } from "@spa/shared";

export const IPersonaMemoryPort = Symbol("IPersonaMemoryPort");
export const IKnowledgeRetrievalPort = Symbol("IKnowledgeRetrievalPort");

export interface RetrievedGroundingItem {
  readonly id: string;
  readonly text: string;
  readonly sourceType: string;
  readonly riskClass?: string;
  readonly score: number;
}

export interface IKnowledgeRetrievalPort {
  retrieveEvidence(params: {
    query: string;
    domain?: string;
    riskClass?: string;
    limit?: number;
  }): Promise<RetrievedGroundingItem[]>;
}

export interface IPersonaMemoryPort {
  retrieveMemories(params: {
    personaId: string;
    query: string;
    kinds?: readonly string[];
    limit?: number;
  }): Promise<RetrievedGroundingItem[]>;
}

export interface PersonaMemoryProfileBoundary {
  readonly profile?: PersonaProfile;
}
