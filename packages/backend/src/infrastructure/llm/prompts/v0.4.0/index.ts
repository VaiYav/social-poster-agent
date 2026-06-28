export { researchExtractPrompt } from './research-extract.js'
export { hookGenerationPrompt } from './hook-generation.js'
export { draftXPrompt } from './draft-x.js'
export {
  ENGAGEMENT_DECISION_SYSTEM_PROMPT,
  ENGAGEMENT_COMMENT_SYSTEM_PROMPT,
  buildDecisionUserPrompt,
  buildCommentUserPrompt,
  parseDecisionResponse,
} from './engagement-decision.js'

import type { PromptTemplate } from '../../prompt-registry.js'
import { researchExtractPrompt } from './research-extract.js'
import { hookGenerationPrompt } from './hook-generation.js'
import { draftXPrompt } from './draft-x.js'

/**
 * All v0.4.0 prompt templates.
 * Used by PromptRegistry bootstrap to register the '0.4.0' and 'latest' versions.
 */
export const v040Prompts: PromptTemplate[] = [
  researchExtractPrompt,
  hookGenerationPrompt,
  draftXPrompt,
]
