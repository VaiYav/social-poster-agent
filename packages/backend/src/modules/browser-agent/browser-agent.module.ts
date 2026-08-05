import { Module } from '@nestjs/common';
import { BrowserAgentService } from './browser-agent.service.js';
import { LlmModule } from '../../infrastructure/llm/llm.module.js';

/**
 * BrowserAgentModule — provides BrowserAgentService (LLM-in-the-loop engine #47).
 *
 * Depends on LlmModule for vision-capable LLM calls (generateVision).
 * Imported by SyndicationModule (when SYNDICATION_ENABLED=true).
 *
 * The BrowserAgentService implements the LLM primitives (act/extract/observe/verify)
 * that BrowserFactory delegates to. The wiring happens in BrowserFactory itself —
 * it injects BrowserAgentService via ModuleRef (lazy, to avoid circular deps).
 */
@Module({
  imports: [LlmModule],
  providers: [BrowserAgentService],
  exports: [BrowserAgentService],
})
export class BrowserAgentModule {}
