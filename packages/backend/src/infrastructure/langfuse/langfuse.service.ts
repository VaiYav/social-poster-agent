import { Inject, Injectable, Logger, type OnModuleDestroy } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { CallbackHandler } from "@langfuse/langchain";
import { LangfuseClient, type ChatPromptClient, type TextPromptClient } from "@langfuse/client";
import { propagateAttributes, startActiveObservation } from "@langfuse/tracing";
import { context, ROOT_CONTEXT } from "@opentelemetry/api";
import { shutdownLangfuse } from "../../langfuse-instrumentation.js";
import { CircuitBreaker } from "../../domain/circuit-breaker.js";
import { getErrorMessage } from "../common/error-utils.js";
import { LANGFUSE_PROMPT_BREAKER } from "./langfuse.tokens.js";

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

export type LangfuseTraceValue = string | number | boolean | null;
export type LangfuseTraceData = Readonly<Record<string, LangfuseTraceValue>>;
export type LangfuseTraceExecutionMode = "runtime" | "eval" | "dry-run" | "replay";
export type LangfuseScoreInput = Parameters<LangfuseClient["score"]["create"]>[0];
export type LangfuseRootName =
  | "agent.generation"
  | "agent.orchestrator-decision"
  | "agent.browser-run"
  | "eval.experiment-item";

export interface LangfuseTraceOptions<T> {
  rootName: LangfuseRootName;
  feature: string;
  sessionId?: string;
  tags?: string[];
  /** Only scalar, non-sensitive dimensions are propagated to Langfuse. */
  metadata?: Record<string, unknown>;
  input?: LangfuseTraceData;
  output?: (result: T) => LangfuseTraceData;
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
  readonly isEnabled: boolean;

  /** Langfuse client for prompt management (null when disabled). */
  private readonly client: LangfuseClient | null = null;

  /** Circuit breaker for prompt fetches — prevents cascading timeouts. */
  private readonly promptCircuitBreaker: CircuitBreaker;
  private readonly environment: string;
  private readonly executionMode: LangfuseTraceExecutionMode;
  private readonly sourceSha: string | undefined;

  constructor(
    @Inject(LANGFUSE_PROMPT_BREAKER) promptCircuitBreaker: CircuitBreaker,
    private readonly configService: ConfigService,
  ) {
    this.promptCircuitBreaker = promptCircuitBreaker;
    this.isEnabled = !!this.configService.get<string>("LANGFUSE_PUBLIC_KEY");
    this.environment = resolveEnvironment(
      readConfigString(this.configService, "LANGFUSE_TRACING_ENVIRONMENT") ??
        readConfigString(this.configService, "NODE_ENV") ??
        "development",
    );
    this.executionMode = resolveExecutionMode(this.configService);
    this.sourceSha = resolveSourceSha(this.configService);
    if (this.isEnabled) {
      try {
        this.client = new LangfuseClient({
          publicKey: this.configService.get<string>("LANGFUSE_PUBLIC_KEY")!,
          secretKey: this.configService.get<string>("LANGFUSE_SECRET_KEY")!,
          baseUrl: this.configService.get<string>(
            "LANGFUSE_BASE_URL",
            "https://us.cloud.langfuse.com",
          ),
        });
      } catch (err) {
        this.logger.warn(
          `Failed to init LangfuseClient — prompt management disabled: ${getErrorMessage(err)}`,
        );
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
      const feature = opts?.tags?.[0] ?? "unknown";
      const tags = [
        ...new Set([...(opts?.tags ?? []), ...(feature !== "unknown" ? [feature] : [])]),
      ];
      return new CallbackHandler({
        sessionId: opts?.sessionId,
        userId: opts?.userId,
        tags,
        traceMetadata: this.buildTraceMetadata(feature, opts?.sessionId, opts?.traceMetadata),
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
   * Run a workflow beneath one stable logical root observation.
   *
   * `propagateAttributes` deliberately wraps the callback that creates child
   * observations: Langfuse only applies propagated fields to observations
   * created after the propagation scope starts. When tracing is disabled this
   * is a direct function call, preserving the zero-overhead fallback path.
   */
  async withTrace<T>(options: LangfuseTraceOptions<T>, fn: () => Promise<T>): Promise<T> {
    if (!this.isEnabled) return fn();

    const tags = [...new Set([...(options.tags ?? []), options.feature])];
    const metadata = this.buildTraceMetadata(options.feature, options.sessionId, options.metadata);

    // Langfuse uses the active OTel context by default. Reset it here so an
    // HTTP/Sentry span cannot accidentally become the parent of this logical
    // agent root; child observations are still created in the root context.
    return context.with(ROOT_CONTEXT, () =>
      startActiveObservation(
        options.rootName,
        async (root) =>
          propagateAttributes(
            {
              traceName: options.rootName,
              sessionId: options.sessionId,
              tags,
              environment: this.environment,
              metadata,
            },
            async () => {
              if (options.input) {
                root.update({ input: this.sanitizeTraceData(options.input) });
              }

              try {
                const result = await fn();
                root.update({
                  output: this.sanitizeTraceData(
                    options.output?.(result) ?? { status: "completed" },
                  ),
                });
                return result;
              } catch (error) {
                // Keep provider errors out of root status metadata. Child
                // observations retain their own error semantics without
                // risking accidental credential/URL capture in this root.
                root.update({ level: "ERROR", statusMessage: "trace failed" });
                throw error;
              }
            },
          ),
        { asType: "agent" },
      ),
    );
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
    label = "production",
  ): Promise<ChatPromptClient | undefined> {
    const client = this.client;
    if (!client) return undefined;
    if (!this.promptCircuitBreaker.canExecute()) return undefined;
    try {
      return await this.promptCircuitBreaker.execute(() =>
        client.prompt.get(name, {
          type: "chat",
          label,
          cacheTtlSeconds: 300,
          fetchTimeoutMs: 3000,
          maxRetries: 1,
          fallback,
        }),
      );
    } catch (err) {
      this.logger.warn(
        `Failed to fetch chat prompt "${name}" (label: ${label}) from Langfuse: ${getErrorMessage(err)}`,
      );
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
    label = "production",
  ): Promise<TextPromptClient | undefined> {
    const client = this.client;
    if (!client) return undefined;
    if (!this.promptCircuitBreaker.canExecute()) return undefined;
    try {
      return await this.promptCircuitBreaker.execute(() =>
        client.prompt.get(name, {
          type: "text",
          label,
          cacheTtlSeconds: 300,
          fetchTimeoutMs: 3000,
          maxRetries: 1,
          fallback,
        }),
      );
    } catch (err) {
      this.logger.warn(
        `Failed to fetch text prompt "${name}" (label: ${label}) from Langfuse: ${getErrorMessage(err)}`,
      );
      return undefined;
    }
  }

  /**
   * Queue and flush one score without exposing the SDK client to domain code.
   * Returns false when Langfuse is disabled or the score could not be sent;
   * callers keep the durable PostgreSQL record for later reconciliation.
   */
  async createScore(input: LangfuseScoreInput): Promise<boolean> {
    const client = this.client;
    if (!client || (!input.traceId && !input.observationId)) return false;
    try {
      client.score.create(input);
      await client.flush();
      return true;
    } catch (err) {
      this.logger.warn(`Failed to sync Langfuse score: ${getErrorMessage(err)}`);
      return false;
    }
  }

  /**
   * Graceful shutdown — flushes all queued traces before the module is
   * destroyed. Called by NestJS on SIGTERM/SIGINT via shutdown hooks.
   */
  async onModuleDestroy(): Promise<void> {
    await shutdownLangfuse();
  }

  private buildTraceMetadata(
    feature: string,
    sessionId: string | undefined,
    metadata?: Record<string, unknown>,
  ): Record<string, string> {
    const propagated: Record<string, string> = {};
    for (const [key, value] of Object.entries(metadata ?? {})) {
      if (isSensitiveTraceKey(key)) continue;
      const normalized = toTraceString(value);
      if (normalized !== undefined) propagated[key] = normalized;
    }

    propagated.feature = clampTraceString(feature);
    propagated.environment = this.environment;
    propagated.execution_mode = this.executionMode;
    if (sessionId) propagated.run_id = clampTraceString(sessionId);
    if (this.sourceSha) propagated.source_sha = this.sourceSha;
    return propagated;
  }

  private sanitizeTraceData(data: LangfuseTraceData): LangfuseTraceData {
    const sanitized: Record<string, LangfuseTraceValue> = {};
    for (const [key, value] of Object.entries(data)) {
      if (isSensitiveTraceKey(key)) continue;
      if (typeof value === "string") sanitized[key] = clampTraceString(value);
      else if (typeof value === "number" && Number.isFinite(value)) sanitized[key] = value;
      else if (typeof value === "boolean" || value === null) sanitized[key] = value;
    }
    return sanitized;
  }
}

const TRACE_VALUE_LIMIT = 200;

function readConfigString(config: ConfigService, key: string): string | undefined {
  const value = config.get<unknown>(key);
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function resolveEnvironment(value: string): string {
  const normalized = value
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, "-")
    .slice(0, 40)
    .replace(/^-+|-+$/g, "");
  return normalized && !normalized.startsWith("langfuse") ? normalized : "development";
}

function resolveExecutionMode(config: ConfigService): LangfuseTraceExecutionMode {
  const explicit = (
    readConfigString(config, "LANGFUSE_EXECUTION_MODE") ??
    readConfigString(config, "EXECUTION_MODE")
  )?.toLowerCase();
  if (
    explicit === "runtime" ||
    explicit === "eval" ||
    explicit === "dry-run" ||
    explicit === "replay"
  ) {
    return explicit;
  }
  return readConfigString(config, "SPA_DRY_RUN")?.toLowerCase() === "true" ? "dry-run" : "runtime";
}

function resolveSourceSha(config: ConfigService): string | undefined {
  for (const key of ["SOURCE_SHA", "RELEASE_SHA", "GIT_SHA", "COMMIT_SHA", "VITE_GIT_SHA"]) {
    const value = readConfigString(config, key);
    if (value) return clampTraceString(value);
  }
  return undefined;
}

function isSensitiveTraceKey(key: string): boolean {
  return /(?:api[_-]?key|secret|password|access[_-]?token|refresh[_-]?token|cookie|authorization|credential|private[_-]?key|proxy(?:[_-]?url)?)/i.test(
    key,
  );
}

function toTraceString(value: unknown): string | undefined {
  if (typeof value === "string") return clampTraceString(value);
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value === "boolean") return String(value);
  return undefined;
}

function clampTraceString(value: string): string {
  return value.length <= TRACE_VALUE_LIMIT ? value : `${value.slice(0, TRACE_VALUE_LIMIT - 3)}...`;
}
