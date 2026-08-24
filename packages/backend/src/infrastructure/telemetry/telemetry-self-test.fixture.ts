import { createHash } from "node:crypto";
import type { LlmAttemptTelemetry } from "../../domain/ports/llm.port.js";
import type { PromptReference } from "../../domain/ports/prompt.port.js";
import type {
  DisabledTracingPathEvidence,
  TelemetryPromptLinkProbe,
  TelemetryRedactionCanary,
  TelemetrySelfTestFixture,
  TelemetryWorkingTreeState,
} from "./telemetry-self-test.js";

export interface SyntheticTelemetryFixtureOptions {
  sourceSha: string;
  workingTree: TelemetryWorkingTreeState;
  dirtyPathCount: number;
  disabledPath: DisabledTracingPathEvidence;
}

/** Synthetic values deliberately assembled at runtime so they cannot be mistaken for credentials. */
export function createTelemetryRedactionCanaries(): readonly TelemetryRedactionCanary[] {
  return [
    { id: "api_key", value: ["sk", "eval104", "api", "canary"].join("-") },
    { id: "cookie", value: ["sessionid", "eval104-cookie-canary"].join("=") },
    { id: "password", value: ["eval104", "password", "canary"].join("-") },
    { id: "bearer_token", value: ["Bearer", "eval104.bearer.canary"].join(" ") },
    {
      id: "proxy_credentials",
      value: ["http://eval104-proxy-user", "eval104-proxy-pass@proxy.invalid:8080"].join(":"),
    },
    {
      id: "private_source_text",
      value: ["EVAL104", "PRIVATE", "SOURCE", "CANARY"].join("_"),
    },
  ];
}

/**
 * Deterministic EVAL-104 fixture: no network, provider SDK, hosted Langfuse mutation,
 * wall clock, random number, or secret-backed configuration is consulted.
 */
export function createSyntheticTelemetryFixture(
  options: SyntheticTelemetryFixtureOptions,
): TelemetrySelfTestFixture {
  const canaries = createTelemetryRedactionCanaries();
  const canaryBlob = canaries.map((canary) => canary.value).join(" | ");
  const nativePrompt = {
    name: "research-extract",
    version: 7,
    type: "chat",
    prompt: canaryBlob,
  };
  const nativeReference: PromptReference = {
    name: "research-extract",
    label: "production",
    version: 7,
    isFallback: false,
    nativePrompt,
  };
  const fallbackReference: PromptReference = {
    name: "draft-post",
    label: "production",
    isFallback: true,
    fallbackDigest: createHash("sha256")
      .update("EVAL-104 deterministic fallback prompt template", "utf8")
      .digest("hex"),
  };

  const attempts: readonly LlmAttemptTelemetry[] = [
    {
      llm_role: "facts",
      provider_requested: "groq",
      provider_actual: "groq",
      model_requested: "llama-4-scout",
      model_actual: "llama-4-scout",
      model_snapshot_or_alias: "llama-4-scout",
      fallback_policy: "role_chain_then_fallback",
      attempt_index: 0,
      fallback_depth: 0,
      cache_hit: false,
      rate_limit_retry: false,
      reasoning_effort: "not_sent",
      temperature_sent: 0,
      max_output_tokens: 256,
      outcome: "error",
      normalized_error_category: "rate_limit",
      cost_source: "unknown",
      latency_ms: 19,
      error_status_code: 429,
      prompt_name: "research-extract",
      prompt_version: 7,
      prompt_label: "production",
      prompt_is_fallback: false,
    },
    {
      llm_role: "facts",
      provider_requested: "groq",
      provider_actual: "openai",
      model_requested: "llama-4-scout",
      model_actual: "gpt-5-nano-2026-08-01",
      model_snapshot_or_alias: "gpt-5-nano-2026-08-01",
      fallback_policy: "role_chain_then_fallback",
      attempt_index: 1,
      fallback_depth: 1,
      cache_hit: false,
      rate_limit_retry: false,
      reasoning_effort: "minimal",
      temperature_sent: "not_sent",
      max_output_tokens: 256,
      outcome: "success",
      normalized_error_category: "none",
      input_tokens: 120,
      output_tokens: 34,
      reasoning_tokens: 8,
      cached_input_tokens: 16,
      total_tokens: 162,
      cost_usd: 0.000_042,
      cost_source: "provider",
      latency_ms: 43,
      time_to_first_token_ms: 12,
      prompt_name: "research-extract",
      prompt_version: 7,
      prompt_label: "production",
      prompt_is_fallback: false,
    },
  ];
  const promptLinks: readonly TelemetryPromptLinkProbe[] = [
    {
      observationName: "generation.research_extract",
      reference: nativeReference,
      linkedNativePrompt: nativePrompt,
    },
    {
      observationName: "generation.draft.X",
      reference: fallbackReference,
    },
  ];

  return {
    sourceSha: options.sourceSha,
    workingTree: options.workingTree,
    dirtyPathCount: options.dirtyPathCount,
    attempts,
    promptLinks,
    callbackMetadata: [
      {
        feature: "generation",
        environment: "test",
        execution_mode: "eval",
        apiKey: canaries[0]?.value,
        cookie: canaries[1]?.value,
        password: canaries[2]?.value,
        authorization: canaries[3]?.value,
        proxyUrl: canaries[4]?.value,
        privateSource: canaries[5]?.value,
        nested_untrusted_value: canaryBlob,
      },
    ],
    telemetryRecords: [
      {
        ...attempts[0],
        provider_debug_context: canaryBlob,
        request_headers: { authorization: canaries[3]?.value, cookie: canaries[1]?.value },
      },
      {
        ...attempts[1],
        private_source_text: canaryBlob,
      },
    ],
    errors: [
      Object.assign(new Error(`provider timeout ${canaryBlob}`), {
        status: 504,
        apiKey: canaries[0]?.value,
      }),
    ],
    disabledPath: options.disabledPath,
    redactionCanaries: canaries,
  };
}

export function createIncompleteSyntheticTelemetryFixture(
  options: SyntheticTelemetryFixtureOptions,
): TelemetrySelfTestFixture {
  const complete = createSyntheticTelemetryFixture(options);
  const firstAttempt = complete.attempts[0];
  if (!firstAttempt) throw new Error("synthetic fixture unexpectedly has no attempts");
  return {
    ...complete,
    attempts: [
      {
        ...firstAttempt,
        provider_actual: "",
        model_actual: "unknown",
        latency_ms: Number.NaN,
      },
    ],
    promptLinks: [],
  };
}
