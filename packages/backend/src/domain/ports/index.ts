// Port interfaces — abstract contracts for infrastructure adapters.
// Used with Symbol-token DI for testability and DDD compliance (§17 principle 7).

export { IBrowserPort, type IBrowserPort as IBrowserPortType } from "./browser.port.js";
export { ILlmPort, type ILlmPort as ILlmPortType } from "./llm.port.js";
export { IContentPort, type IContentPort as IContentPortType } from "./content.port.js";
export {
  IPromptPort,
  type IPromptPort as IPromptPortType,
  PROMPT_FALLBACK_PROVIDERS,
  type IPromptFallbackProvider,
} from "./prompt.port.js";
export {
  IEngagementDecisionPort,
  type EngagementAction,
  type EngagementSource,
  type PostContext,
  type ActionDecision,
  type IEngagementDecisionPort as IEngagementDecisionPortType,
} from "./engagement-decision.port.js";
export {
  IPostingQueuePort,
  type IPostingQueuePort as IPostingQueuePortType,
} from "./posting-queue.port.js";
export {
  ILinkPort,
  type ILinkPort as ILinkPortType,
  type LinkNetwork,
  type CreateTrackableLinkParams,
  type TrackableLink,
  type FunnelReportParams,
  type LinkFunnelReport,
  LinkServiceUnavailableError,
} from "./link.port.js";
