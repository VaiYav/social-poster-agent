import { Injectable, Logger, type OnModuleDestroy } from '@nestjs/common';
import { CallbackHandler } from '@langfuse/langchain';
import { LangfuseClient, type ChatPromptClient, type TextPromptClient } from '@langfuse/client';
import { shutdownLangfuse } from '../../langfuse-instrumentation.js';

/**
 * Options for creating a Langfuse CallbackHandler.
 * All fields are optional — pass only what's relevant for the trace context.
 */
export interface LangfuseHandlerOptions {
  /** Groups traces from the same conversation/run together (Sessions view). */
  sessionId?: string;
  /** Enables user-level filtering and cost attribution. */
  userId?: string;
  /** Per-feature analytics (e.g. 'generation', 'orchestrator', 'engagement'). */
  tags?: string[];
  /** Trace-level metadata — key/value pairs attached to the trace. */
  traceMetadata?: Record<string, unknown>;
  /** Version tag for all traces/observations from this handler. */
  version?: string;
}

/**
 * LangfuseService — thin wrapper around the @langfuse/langchain CallbackHandler.
 *
 * Provides a NestJS-injectable facade for creating Langfuse tracing handlers
 * with consistent configuration. The actual OTel SDK is initialized in
 * `langfuse-instrumentation.ts` (imported at the top of main.ts before any
 * other module loads).
 *
 * When Langfuse is disabled (LANGFUSE_PUBLIC_KEY not set), `isEnabled` returns
 * false and `createHandler` returns undefined — callers should check
 * `isEnabled` or guard against undefined handlers before passing to LangChain.
 *
 * Refs:
 *   - https://langfuse.com/docs/integrations/langchain
 *   - https://langfuse.com/docs/observability/sdk/overview
 */
@Injectable()
export class LangfuseService implements OnModuleDestroy {
  private readonly logger = new Logger(LangfuseService.name);

  /** Whether Langfuse tracing is enabled (LANGFUSE_PUBLIC_KEY is set). */
  readonly isEnabled: boolean = !!process.env.LANGFUSE_PUBLIC_KEY;

  /** Langfuse client for prompt management (null when disabled). */
  private readonly client: LangfuseClient | null = null;

  constructor() {
    if (this.isEnabled) {
      try {
        this.client = new LangfuseClient({
          publicKey: process.env.LANGFUSE_PUBLIC_KEY!,
          secretKey: process.env.LANGFUSE_SECRET_KEY!,
          baseUrl: process.env.LANGFUSE_BASE_URL || 'https://cloud.langfuse.com',
        });
      } catch (err) {
        this.logger.warn(`Failed to init LangfuseClient — prompt management disabled: ${(err as Error).message}`);
      }
    }
  }

  /**
   * Create a Langfuse CallbackHandler for a LangChain/LangGraph invocation.
   * Returns undefined when Langfuse is disabled — callers should filter out
   * undefined before passing to `model.invoke(messages, { callbacks })`.
   *
   * The handler captures LLM calls, chain runs, tool calls, and retriever
   * operations as nested observations under a single trace. Token usage,
   * model name, latencies, and inputs/outputs are captured automatically.
   */
  createHandler(opts?: LangfuseHandlerOptions): CallbackHandler | undefined {
    if (!this.isEnabled) return undefined;
    try {
      return new CallbackHandler({
        sessionId: opts?.sessionId,
        userId: opts?.userId,
        tags: opts?.tags,
        traceMetadata: opts?.traceMetadata,
        version: opts?.version,
      });
    } catch (err) {
      // CallbackHandler constructor can fail if the OTel SDK didn't start
      // (e.g. network error during init). Degrade gracefully — no tracing.
      this.logger.warn(
        `Failed to create Langfuse handler — tracing disabled for this call: ${(err as Error).message}`,
      );
      return undefined;
    }
  }

  /**
   * Fetch a chat prompt from Langfuse Prompt Management.
   * Returns undefined when Langfuse is disabled or the prompt is not found.
   * The caller should fall back to a local prompt template.
   */
  async getChatPrompt(name: string): Promise<ChatPromptClient | undefined> {
    if (!this.client) return undefined;
    try {
      return await this.client.prompt.get(name, { type: 'chat', label: 'production', cacheTtlSeconds: 300 });
    } catch (err) {
      this.logger.debug(`Failed to fetch chat prompt "${name}" from Langfuse — using fallback: ${(err as Error).message}`);
      return undefined;
    }
  }

  /**
   * Fetch a text prompt from Langfuse Prompt Management.
   * Returns undefined when Langfuse is disabled or the prompt is not found.
   */
  async getTextPrompt(name: string): Promise<TextPromptClient | undefined> {
    if (!this.client) return undefined;
    try {
      return await this.client.prompt.get(name, { type: 'text', label: 'production', cacheTtlSeconds: 300 });
    } catch (err) {
      this.logger.debug(`Failed to fetch text prompt "${name}" from Langfuse — using fallback: ${(err as Error).message}`);
      return undefined;
    }
  }

  /**
   * Graceful shutdown — flushes all queued traces before the module is
   * destroyed. Called by NestJS on SIGTERM/SIGINT via shutdown hooks.
   */
  async onModuleDestroy(): Promise<void> {
    await shutdownLangfuse();
  }
}
