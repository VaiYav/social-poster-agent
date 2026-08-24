import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";

export interface CompressedPromptPair {
  readonly systemPrompt: string;
  readonly userPrompt: string;
  readonly compressed: boolean;
  readonly method: "disabled" | "heuristic" | "sidecar";
}

@Injectable()
export class PromptCompressionService {
  private readonly logger = new Logger(PromptCompressionService.name);
  private readonly enabled: boolean;
  private readonly minTokens: number;
  private readonly sidecarUrl: string;
  private readonly timeoutMs: number;

  constructor(private readonly config: ConfigService) {
    this.enabled = config.get<string>("LLM_PROMPT_COMPRESSION_ENABLED", "false") === "true";
    this.minTokens = Math.max(
      1,
      Number(config.get<string>("LLM_PROMPT_COMPRESSION_MIN_TOKENS", "500")) || 500,
    );
    this.sidecarUrl = config.get<string>("LLM_PROMPT_COMPRESSION_URL", "").trim();
    this.timeoutMs = Math.max(
      100,
      Number(config.get<string>("LLM_PROMPT_COMPRESSION_TIMEOUT_MS", "1500")) || 1500,
    );
  }

  async compress(systemPrompt: string, userPrompt: string): Promise<CompressedPromptPair> {
    if (!this.enabled || estimateTokens(systemPrompt + userPrompt) < this.minTokens) {
      return { systemPrompt, userPrompt, compressed: false, method: "disabled" };
    }
    if (this.sidecarUrl) {
      try {
        const response = await fetch(this.sidecarUrl, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ systemPrompt, userPrompt }),
          signal: AbortSignal.timeout(this.timeoutMs),
        });
        if (response.ok) {
          const body: unknown = await response.json();
          if (isPromptPair(body)) {
            return { ...body, compressed: true, method: "sidecar" };
          }
        }
        this.logger.warn(`Prompt compression sidecar returned HTTP ${response.status}`);
      } catch (error) {
        this.logger.warn(
          `Prompt compression sidecar unavailable: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    return {
      systemPrompt: heuristicCompress(systemPrompt),
      userPrompt: heuristicCompress(userPrompt),
      compressed: true,
      method: "heuristic",
    };
  }
}

function isPromptPair(value: unknown): value is { systemPrompt: string; userPrompt: string } {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return typeof record.systemPrompt === "string" && typeof record.userPrompt === "string";
}

function heuristicCompress(value: string): string {
  const seen = new Set<string>();
  return value
    .split("\n")
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter((line) => {
      if (!line || seen.has(line)) return false;
      seen.add(line);
      return true;
    })
    .join("\n");
}

function estimateTokens(value: string): number {
  return Math.ceil(value.length / 4);
}
