import { describe, expect, it, vi } from "vitest";
import { PromptCompressionService } from "../../../src/infrastructure/llm/prompt-compression.service.js";

function config(overrides: Record<string, unknown> = {}) {
  return {
    get: vi.fn((key: string, fallback?: unknown) => overrides[key] ?? fallback),
  } as never;
}

describe("COST-001 PromptCompressionService", () => {
  it("is disabled by default and leaves short prompts byte-for-byte unchanged", async () => {
    const service = new PromptCompressionService(config());
    await expect(service.compress(" system  ", " user  ")).resolves.toEqual({
      systemPrompt: " system  ",
      userPrompt: " user  ",
      compressed: false,
      method: "disabled",
    });
  });

  it("uses a deterministic duplicate-line fallback above the configured threshold", async () => {
    const service = new PromptCompressionService(
      config({ LLM_PROMPT_COMPRESSION_ENABLED: "true", LLM_PROMPT_COMPRESSION_MIN_TOKENS: "1" }),
    );
    await expect(service.compress("Rule\nRule\nKeep this", "User\nUser")).resolves.toEqual({
      systemPrompt: "Rule\nKeep this",
      userPrompt: "User",
      compressed: true,
      method: "heuristic",
    });
  });

  it("accepts a valid sidecar response", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ systemPrompt: "compressed system", userPrompt: "compressed user" }),
    }) as unknown as typeof fetch;
    try {
      const service = new PromptCompressionService(
        config({
          LLM_PROMPT_COMPRESSION_ENABLED: "true",
          LLM_PROMPT_COMPRESSION_MIN_TOKENS: "1",
          LLM_PROMPT_COMPRESSION_URL: "http://compressor.test/compress",
        }),
      );
      await expect(service.compress("system", "user")).resolves.toMatchObject({
        systemPrompt: "compressed system",
        userPrompt: "compressed user",
        compressed: true,
        method: "sidecar",
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
