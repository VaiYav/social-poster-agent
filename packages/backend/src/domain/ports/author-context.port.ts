import type { PersonaProfile } from "@spa/shared";
import type { SocialNetwork } from "../../generated/prisma/client.js";
import type { RetrievedGroundingItem } from "./grounding.port.js";

export const IAuthorContextPort = Symbol("IAuthorContextPort");

export interface ResolveAuthorContextParams {
  readonly accountId: string;
  readonly network: SocialNetwork;
  readonly requestedVoiceMode?: string;
  readonly experimentAssignmentId?: string;
  readonly retrievalQuery?: string;
  readonly retrievalDomain?: string;
  readonly retrievalRiskClass?: string;
}

export interface AuthorContextResult {
  readonly accountId: string;
  readonly network: SocialNetwork;
  readonly personaId: string | null;
  readonly personaRevisionId: string | null;
  readonly voiceMode: string;
  readonly experimentAssignmentId: string | null;
  readonly profile: PersonaProfile | null;
  readonly disclosure: string | null;
  readonly safetyPolicyVersion: string | null;
  readonly source: "PERSONA" | "GLOBAL_FALLBACK";
  readonly memoryTrace?: readonly RetrievedGroundingItem[];
  readonly evidenceTrace?: readonly RetrievedGroundingItem[];
  readonly retrieverMode?: "LEXICAL" | "UNAVAILABLE" | "NONE";
}

export interface IAuthorContextPort {
  resolve(params: ResolveAuthorContextParams): Promise<AuthorContextResult>;
}
