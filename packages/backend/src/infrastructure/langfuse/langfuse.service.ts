import { Inject, Injectable, Logger, type OnModuleDestroy } from '@nestjs/common';
import { CallbackHandler } from '@langfuse/langchain';
import { LangfuseClient, type ChatPromptClient, type TextPromptClient } from '@langfuse/client';
import { shutdownLangfuse } from '../../langfuse-instrumentation.js';
import { CircuitBreaker } from '../../domain/circuit-breaker.js';
import { getErrorMessage } from '../common/error-utils.js';
import { LANGFUSE_PROMPT_BREAKER } from './langfuse.tokens.js';

/**
 * Minimal chat message shape for SDK fallback parameter.
 * The SDK's `fallback` accepts `ChatMessage[]` from `@langfuse/core`,
 * which is `{ role: string; content: string }`. We define this locally
 * since `ChatMessage` is not re-exported by `@langfuse/client`.
 */
interface FallbackChatMessage {
  role: string;
  content: string;
}

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

  /** Circuit breaker for prompt fetches — prevents cascading timeouts. */
  private readonly promptCircuitBreaker: CircuitBreaker;

  constructor(
    @Inject(LANGFUSE_PROMPT_BREAKER) promptCircuitBreaker: CircuitBreaker,
  ) {
    this.promptCircuitBreaker = promptCircuitBreaker;
    if (this.isEnabled) {
      try {
        this.client = new LangfuseClient({
          publicKey: process.env.LANGFUSE_PUBLIC_KEY!,
          secretKey: process.env.LANGFUSE_SECRET_KEY!,
          baseUrl: process.env.LANGFUSE_BASE_URL || 'https://us.cloud.langfuse.com',
        });
      } catch (err) {
        this.logger.warn(`Failed to init LangfuseClient — prompt management disabled: ${getErrorMessage(err)}`);
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
        `Failed to create Langfuse handler — tracing disabled for this call: ${getErrorMessage(err)}`,
      );
      return undefined;
    }
  }

  /**
   * Fetch a chat prompt from Langfuse Prompt Management.
   *
   * Passes `fallback` to the SDK — if the fetch fails, the SDK returns a
   * prompt client with `isFallback: true` and the fallback content.
   * Returns undefined only when Langfuse is disabled (no client).
   *
   * @param name Prompt name in Langfuse
   * @param fallback Optional fallback chat messages (Mustache {{var}} syntax)
   * @param label Langfuse prompt label to fetch (e.g. 'production', 'latest', 'v2')
   */
  async getChatPrompt(
    name: string,
    fallback?: FallbackChatMessage[],
    label = 'production',
  ): Promise<ChatPromptClient | undefined> {
    const client = this.client;
    if (!client) return undefined;
    if (!this.promptCircuitBreaker.canExecute()) return undefined;
    try {
      return await this.promptCircuitBreaker.execute(() =>
        client.prompt.get(name, {
          type: 'chat',
          label,
          cacheTtlSeconds: 300,
          fetchTimeoutMs: 3000,
          maxRetries: 1,
          fallback,
        }),
      );
    } catch (err) {
      this.logger.warn(`Failed to fetch chat prompt "${name}" (label: ${label}) from Langfuse: ${getErrorMessage(err)}`);
      return undefined;
    }
  }

  /**
   * Fetch a text prompt from Langfuse Prompt Management.
   *
   * Passes `fallback` to the SDK — if the fetch fails, the SDK returns a
   * prompt client with `isFallback: true` and the fallback content.
   * Returns undefined only when Langfuse is disabled (no client).
   *
   * @param name Prompt name in Langfuse
   * @param fallback Optional fallback text (Mustache {{var}} syntax)
   * @param label Langfuse prompt label to fetch (e.g. 'production', 'latest', 'v2')
   */
  async getTextPrompt(
    name: string,
    fallback?: string,
    label = 'production',
  ): Promise<TextPromptClient | undefined> {
    const client = this.client;
    if (!client) return undefined;
    if (!this.promptCircuitBreaker.canExecute()) return undefined;
    try {
      return await this.promptCircuitBreaker.execute(() =>
        client.prompt.get(name, {
          type: 'text',
          label,
          cacheTtlSeconds: 300,
          fetchTimeoutMs: 3000,
          maxRetries: 1,
          fallback,
        }),
      );
    } catch (err) {
      this.logger.warn(`Failed to fetch text prompt "${name}" (label: ${label}) from Langfuse: ${getErrorMessage(err)}`);
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
