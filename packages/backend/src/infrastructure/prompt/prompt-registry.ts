import { Inject, Injectable, Logger, Optional } from "@nestjs/common";
import type { ConfigService } from "@nestjs/config";
import { LangfuseService } from "../langfuse/langfuse.service.js";
import type {
  IPromptPort,
  IPromptFallbackProvider,
  CompiledChatPrompt,
} from "../../domain/ports/prompt.port.js";
import { PROMPT_FALLBACK_PROVIDERS } from "../../domain/ports/prompt.port.js";
import { getErrorMessage } from "../common/error-utils.js";
import { recordPromptLabel } from "./prompt-label-context.js";
import { interpolate, toMustache } from "../../domain/prompt-interpolation.js";
import { createHash } from "node:crypto";

/**
 * PromptRegistry — facade for prompt management.
 *
 * Implements `IPromptPort` so consumers depend on the port abstraction,
 * not the concrete class (hexagonal architecture).
 *
 * Fallback chain (extensible via PROMPT_FALLBACK_PROVIDERS):
 *   1. Langfuse Prompt Management with label resolution:
 *      - PROMPT_VERSION_<NAME> env var override per prompt
 *      - optional caller-supplied `label` parameter
 *      - PROMPT_VERSION env var (default 'latest')
 *      - label fallback chain: resolved label -> 'production' -> 'latest'
 *   2. Intermediate fallback providers (injected via PROMPT_FALLBACK_PROVIDERS,
 *      tried in order — e.g. local JSON cache, S3. Empty by default.)
 *   3. Inline fallback from the caller (when all above fail)
 *
 * New fallback sources can be added by binding to `PROMPT_FALLBACK_PROVIDERS`
 * without modifying PromptRegistry (OCP).
 *
 * The inline fallback uses `{var}` syntax (for local `interpolate()`).
 * It is converted to `{{var}}` Mustache syntax before passing to the SDK,
 * so `compile()` works correctly on both remote and fallback content.
 *
 * The active version is sourced from the PROMPT_VERSION env var via
 * ConfigService, defaulting to 'latest'.
 */
interface CacheEntry<T> {
  value: T;
  expiresAt: number;
}

@Injectable()
export class PromptRegistry implements IPromptPort {
  private readonly logger = new Logger(PromptRegistry.name);
  private readonly currentVersion: string;
  private readonly fallbackProviders: readonly IPromptFallbackProvider[];
  // P0: compiled prompt cache. Caches final compiled prompts (from any source) keyed by
  // name + resolved label + variable hash, with a 5-minute TTL. Avoids re-interpolating
  // the same fallback prompt and re-compiling the same Langfuse prompt within a run.
  private readonly cache = new Map<string, CacheEntry<CompiledChatPrompt | string>>();
  private readonly cacheTtlMs: number;

  constructor(
    private readonly configService: ConfigService,
    @Optional() private readonly langfuse?: LangfuseService,
    @Optional() @Inject(PROMPT_FALLBACK_PROVIDERS) fallbackProviders?: IPromptFallbackProvider[],
  ) {
    this.currentVersion = this.configService.get<string>("PROMPT_VERSION", "latest") || "latest";
    this.fallbackProviders = fallbackProviders ?? [];
    const rawTtl = Number(this.configService.get<string>("PROMPT_CACHE_TTL_MS", "300000"));
    this.cacheTtlMs = Number.isFinite(rawTtl) && rawTtl > 0 ? rawTtl : 5 * 60 * 1000;
  }

  /**
   * The active prompt version, sourced from PROMPT_VERSION env var.
   * Used for tracking in llmMetadata.
   */
  getCurrentVersion(): string {
    return this.currentVersion;
  }

  /**
   * Fetch and compile a chat prompt from Langfuse Prompt Management.
   *
   * Uses the SDK's native `fallback` parameter — if the Langfuse fetch fails,
   * the SDK returns a prompt client with `isFallback: true` containing the
   * fallback content. This eliminates the need for a manual fallback chain.
   *
   * The inline fallback (from the caller) uses `{var}` syntax (for local
   * `interpolate()`). It is converted to `{{var}}` Mustache syntax before
   * passing to the SDK, so `compile()` works correctly on both remote and
   * fallback content.
   *
   * When Langfuse is completely disabled (no client), falls back to
   * intermediate providers, then `interpolate()` on the inline fallback.
   *
   * @param name Prompt name in Langfuse (e.g. 'research-extract')
   * @param variables Values for {{var}} placeholders
   * @param fallback Optional inline fallback ({var} syntax)
   * @param label Optional Langfuse label override
   */
  async getCompiledChat(
    name: string,
    variables: Record<string, string>,
    fallback?: CompiledChatPrompt,
    label?: string,
  ): Promise<CompiledChatPrompt> {
    const resolvedLabel = this.resolveLabel(name, label);

    // P0: check compiled prompt cache
    const cacheKey = this.makeCacheKey(name, resolvedLabel, variables);
    const cached = this.getCache<CompiledChatPrompt>(cacheKey);
    if (cached) {
      this.logger.debug(`Compiled prompt cache hit: ${name} (${resolvedLabel})`);
      return cached;
    }

    // 1. Try Langfuse with SDK native fallback and label fallback chain
    if (this.langfuse) {
      const sdkFallback = fallback
        ? [
            { role: "system", content: toMustache(fallback.systemPrompt) },
            { role: "user", content: toMustache(fallback.userPrompt) },
          ]
        : undefined;

      const result = await this.fetchChatPrompt(name, sdkFallback, resolvedLabel);
      if (result) {
        try {
          const compiled = result.prompt.compile(variables);
          if (!Array.isArray(compiled)) {
            throw new Error(`Expected array from chat prompt compile, got ${typeof compiled}`);
          }
          const messages = compiled.filter(isChatMessage);
          const systemMsg = messages.find((m) => m.role === "system");
          const userMsg = messages.find((m) => m.role === "user");
          if (systemMsg && userMsg) {
            const isFallback = result.isFallback;
            recordPromptLabel(name, result.label, isFallback);
            return this.setCache(cacheKey, {
              systemPrompt: systemMsg.content,
              userPrompt: userMsg.content,
              label: result.label,
              isFallback,
            });
          }
        } catch (err) {
          this.logger.warn(
            `Langfuse compile failed for "${name}" (label: ${result.label}): ${getErrorMessage(err)}`,
          );
        }
      }
    }

    // 2. Try intermediate fallback providers (extensible via DI)
    for (const provider of this.fallbackProviders) {
      try {
        const result = await provider.tryGetChatPrompt(name, variables);
        if (result) {
          const fallbackLabel = result.label ?? resolvedLabel;
          const isFallback = result.isFallback ?? true;
          recordPromptLabel(name, fallbackLabel, isFallback);
          return this.setCache(cacheKey, {
            systemPrompt: result.systemPrompt,
            userPrompt: result.userPrompt,
            label: fallbackLabel,
            isFallback,
          });
        }
      } catch (err) {
        this.logger.warn(`Fallback provider failed for "${name}": ${getErrorMessage(err)}`);
      }
    }

    // 3. Use inline fallback with local interpolation
    if (fallback) {
      recordPromptLabel(name, resolvedLabel, true);
      return this.setCache(cacheKey, {
        systemPrompt: interpolate(fallback.systemPrompt, variables),
        userPrompt: interpolate(fallback.userPrompt, variables),
        label: resolvedLabel,
        isFallback: true,
      });
    }

    this.logger.error(
      `Chat prompt "${name}" not found in Langfuse, fallback providers, or inline fallback`,
    );
    throw new Error(`Prompt "${name}" not found in Langfuse or fallback`);
  }

  /**
   * Fetch and compile a text prompt from Langfuse Prompt Management.
   *
   * Uses the SDK's native `fallback` parameter. The inline fallback is
   * converted from `{var}` to `{{var}}` Mustache syntax before passing.
   *
   * @param name Prompt name in Langfuse (e.g. 'critique-post')
   * @param variables Values for {{var}} placeholders
   * @param fallback Optional inline fallback text ({var} syntax)
   * @param label Optional Langfuse label override
   */
  async getCompiledText(
    name: string,
    variables: Record<string, string>,
    fallback?: string,
    label?: string,
  ): Promise<string> {
    const resolvedLabel = this.resolveLabel(name, label);

    // P0: check compiled prompt cache
    const cacheKey = this.makeCacheKey(name, resolvedLabel, variables);
    const cached = this.getCache<string>(cacheKey);
    if (cached) {
      this.logger.debug(`Compiled prompt cache hit: ${name} (${resolvedLabel})`);
      return cached;
    }

    // 1. Try Langfuse with SDK native fallback and label fallback chain
    if (this.langfuse) {
      const sdkFallback = fallback ? toMustache(fallback) : undefined;
      const result = await this.fetchTextPrompt(name, sdkFallback, resolvedLabel);
      if (result) {
        try {
          const compiled = result.prompt.compile(variables);
          if (typeof compiled !== "string") {
            throw new Error(`Expected string from text prompt compile, got ${typeof compiled}`);
          }
          recordPromptLabel(name, result.label, result.isFallback);
          return this.setCache(cacheKey, compiled);
        } catch (err) {
          this.logger.warn(
            `Langfuse compile failed for "${name}" (label: ${result.label}): ${getErrorMessage(err)}`,
          );
        }
      }
    }

    // 2. Try intermediate fallback providers (extensible via DI)
    for (const provider of this.fallbackProviders) {
      try {
        const result = await provider.tryGetTextPrompt(name, variables);
        if (result !== null) {
          recordPromptLabel(name, resolvedLabel, true);
          return this.setCache(cacheKey, result);
        }
      } catch (err) {
        this.logger.warn(
          `Fallback provider failed for text prompt "${name}": ${getErrorMessage(err)}`,
        );
      }
    }

    // 3. Use inline fallback with local interpolation
    if (fallback) {
      recordPromptLabel(name, resolvedLabel, true);
      return this.setCache(cacheKey, interpolate(fallback, variables));
    }

    this.logger.error(
      `Text prompt "${name}" not found in Langfuse, fallback providers, or inline fallback`,
    );
    throw new Error(`Text prompt "${name}" not found in Langfuse or fallback`);
  }

  /**
   * Resolve the effective label for a prompt:
   *   1. PROMPT_VERSION_<NAME> env var override
   *   2. caller-supplied `label` parameter
   *   3. PROMPT_VERSION env var
   */
  private resolveLabel(name: string, requestedLabel?: string): string {
    const perPromptKey = this.perPromptEnvKey(name);
    const perPromptLabel = this.configService.get<string>(perPromptKey, "");
    if (perPromptLabel) return perPromptLabel;
    if (requestedLabel) return requestedLabel;
    return this.currentVersion;
  }

  private perPromptEnvKey(name: string): string {
    const normalized = name.replace(/[^a-zA-Z0-9]+/g, "_").toUpperCase();
    return `PROMPT_VERSION_${normalized}`;
  }

  private makeCacheKey(name: string, label: string, variables: Record<string, string>): string {
    const varHash = createHash("sha256").update(JSON.stringify(variables)).digest("hex");
    return `${name}:${label}:${varHash}`;
  }

  private getCache<T>(key: string): T | undefined {
    const entry = this.cache.get(key);
    if (!entry) return undefined;
    if (Date.now() >= entry.expiresAt) {
      this.cache.delete(key);
      return undefined;
    }
    return entry.value as T;
  }

  private setCache<T>(key: string, value: T): T {
    this.cache.set(key, {
      value: value as CompiledChatPrompt | string,
      expiresAt: Date.now() + this.cacheTtlMs,
    });
    return value;
  }

  /**
   * Build the label fallback chain:
   *   resolvedLabel -> 'production' -> 'latest'
   * Duplicates are removed so we don't try the same label twice.
   */
  private buildLabelChain(resolvedLabel: string): string[] {
    const chain = [resolvedLabel];
    if (resolvedLabel !== "production") chain.push("production");
    if (resolvedLabel !== "latest") chain.push("latest");
    return chain;
  }

  private async fetchWithLabelChain<T extends { isFallback: boolean }, F>(
    name: string,
    sdkFallback: F | undefined,
    resolvedLabel: string,
    fetcher: (label: string, fallback: F | undefined) => Promise<T | undefined>,
  ): Promise<{ prompt: T; label: string; isFallback: boolean } | undefined> {
    if (!this.langfuse) return undefined;
    const chain = this.buildLabelChain(resolvedLabel);
    for (let i = 0; i < chain.length; i++) {
      const label = chain[i]!;
      const isLast = i === chain.length - 1;
      const fallback = isLast ? sdkFallback : undefined;
      try {
        const result = await fetcher(label, fallback);
        if (result && (!result.isFallback || isLast)) {
          return { prompt: result, label, isFallback: result.isFallback };
        }
      } catch (err) {
        this.logger.warn(
          `Langfuse fetch failed for "${name}" (label: ${label}): ${getErrorMessage(err)}`,
        );
      }
    }
    return undefined;
  }

  private async fetchChatPrompt(
    name: string,
    sdkFallback: { role: string; content: string }[] | undefined,
    resolvedLabel: string,
  ): Promise<
    | {
        prompt: { compile(vars: Record<string, string>): unknown };
        label: string;
        isFallback: boolean;
      }
    | undefined
  > {
    return this.fetchWithLabelChain(name, sdkFallback, resolvedLabel, async (label, fallback) =>
      this.langfuse!.getChatPrompt(name, fallback, label),
    );
  }

  private async fetchTextPrompt(
    name: string,
    sdkFallback: string | undefined,
    resolvedLabel: string,
  ): Promise<
    | {
        prompt: { compile(vars: Record<string, string>): unknown };
        label: string;
        isFallback: boolean;
      }
    | undefined
  > {
    return this.fetchWithLabelChain(name, sdkFallback, resolvedLabel, async (label, fallback) =>
      this.langfuse!.getTextPrompt(name, fallback, label),
    );
  }
}

// ── Utility functions ──────────────────────────────────────────────────────

/**
 * Type guard: filter Langfuse `compile()` results to resolved chat messages.
 * Langfuse returns `any[]` which may include unresolved placeholder objects
 * (`{ type: 'placeholder', name: string }`). This guard ensures we only
 * process actual `{ role, content }` messages.
 */
function isChatMessage(msg: unknown): msg is { role: string; content: string } {
  return (
    typeof msg === "object" &&
    msg !== null &&
    "role" in msg &&
    "content" in msg &&
    typeof msg.role === "string" &&
    typeof msg.content === "string"
  );
}
