import type { LlmNormalizedErrorCategory } from "../../domain/ports/llm.port.js";
import { TokenBudgetExceeded } from "./token-budget.service.js";

/** Distinguishes provider success with unusable output from transport failures. */
export class EmptyLlmOutputError extends Error {
  constructor(providerName: string) {
    super(`${providerName} returned empty content`);
    this.name = "EmptyLlmOutputError";
  }
}

export function extractLlmErrorStatusCode(error: unknown): number | undefined {
  if (!error || typeof error !== "object") return undefined;
  const status = Reflect.get(error, "status") ?? Reflect.get(error, "statusCode");
  return typeof status === "number" && Number.isFinite(status) ? status : undefined;
}

function extractErrorCode(error: unknown): string {
  if (!error || typeof error !== "object") return "";
  const code = Reflect.get(error, "code") ?? Reflect.get(error, "lc_error_code");
  return typeof code === "string" ? code.toLowerCase() : "";
}

function extractErrorName(error: unknown): string {
  if (!error || typeof error !== "object") return "";
  const name = Reflect.get(error, "name");
  return typeof name === "string" ? name.toLowerCase() : "";
}

function extractErrorMessage(error: unknown): string {
  if (typeof error === "string") return error.toLowerCase();
  if (!error || typeof error !== "object") return "";
  const message = Reflect.get(error, "message");
  return typeof message === "string" ? message.toLowerCase() : "";
}

/** Normalize provider- and transport-specific failures without retaining raw text. */
export function normalizeLlmErrorCategory(error: unknown): LlmNormalizedErrorCategory {
  if (error instanceof TokenBudgetExceeded) return "budget_exceeded";
  if (error instanceof EmptyLlmOutputError) return "empty_output";

  const status = extractLlmErrorStatusCode(error);
  const code = extractErrorCode(error);
  const name = extractErrorName(error);
  const message = extractErrorMessage(error);

  if (name === "aborterror" || code === "abort_err" || /\babort(?:ed)?\b/.test(message)) {
    return "aborted";
  }

  if (
    status === 429 ||
    code === "rate_limit_exceeded" ||
    code === "model_rate_limit" ||
    /\b429\b|rate[ _-]?limit|too many requests/.test(message)
  ) {
    return "rate_limit";
  }

  if (
    status === 401 ||
    status === 403 ||
    /\b(unauthorized|invalid api key|forbidden)\b/.test(message)
  ) {
    return "auth";
  }

  if (
    status === 402 ||
    code === "insufficient_quota" ||
    code === "billing_error" ||
    /\b(insufficient (?:balance|quota|credits?)|billing|payment required)\b/.test(message)
  ) {
    return "billing";
  }

  if (
    status === 404 ||
    code === "model_not_found" ||
    code === "deployment_not_found" ||
    /\bmodel\b.*\b(not found|does not exist|unknown)\b/.test(message)
  ) {
    return "model_not_found";
  }

  if (
    status === 408 ||
    status === 504 ||
    name === "timeouterror" ||
    code === "etimedout" ||
    code === "econnaborted" ||
    /\b(timeout|timed out)\b/.test(message)
  ) {
    return "timeout";
  }

  if (/\bempty (?:content|output|response)\b/.test(message)) return "empty_output";
  if (/\bbudget\b.*\b(exceeded|over)\b/.test(message)) return "budget_exceeded";

  return "unknown";
}

/** Safe for logs and aggregate errors: never includes provider-returned text. */
export function safeLlmErrorSummary(error: unknown): string {
  const category = normalizeLlmErrorCategory(error);
  const status = extractLlmErrorStatusCode(error);
  return status === undefined ? category : `${category} (HTTP ${status})`;
}
