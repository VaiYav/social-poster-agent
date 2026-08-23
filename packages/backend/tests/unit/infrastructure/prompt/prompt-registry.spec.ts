/**
 * PromptRegistry unit tests.
 *
 * Tests the facade behavior: Langfuse-first with SDK native fallback,
 * inline fallback when Langfuse is disabled, and version tracking.
 *
 * Source: packages/backend/src/infrastructure/prompt/prompt-registry.ts
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { ConfigService } from "@nestjs/config";
import { PromptRegistry } from "../../../../src/infrastructure/prompt/prompt-registry.js";
import type { LangfuseService } from "../../../../src/infrastructure/langfuse/langfuse.service.js";
import {
  consumePromptReference,
  withPromptLabelContext,
} from "../../../../src/infrastructure/prompt/prompt-label-context.js";

// ── Helpers ──

function createMockConfigService(overrides: Record<string, unknown> = {}): ConfigService {
  const defaults: Record<string, unknown> = {
    PROMPT_VERSION: "0.4.0",
  };
  return {
    get: vi.fn(
      (key: string, defaultValue?: unknown) => overrides[key] ?? defaults[key] ?? defaultValue,
    ),
  } as unknown as ConfigService;
}

// ── Tests ──

describe("PromptRegistry", () => {
  let registry: PromptRegistry;
  let configService: ConfigService;

  beforeEach(() => {
    vi.clearAllMocks();
    configService = createMockConfigService();
    registry = new PromptRegistry(configService, undefined, []);
  });

  describe("getCurrentVersion", () => {
    it("returns the active version from PROMPT_VERSION env var", () => {
      configService = createMockConfigService({ PROMPT_VERSION: "0.4.0" });
      registry = new PromptRegistry(configService, undefined, []);
      expect(registry.getCurrentVersion()).toBe("0.4.0");
    });

    it('defaults to "latest" when PROMPT_VERSION is not set', () => {
      configService = {
        get: vi.fn((_key: string, defaultValue?: unknown) => defaultValue),
      } as unknown as ConfigService;
      registry = new PromptRegistry(configService, undefined, []);
      expect(registry.getCurrentVersion()).toBe("latest");
    });
  });

  describe("getCompiledChat (no Langfuse — inline fallback)", () => {
    it("interpolates {var} placeholders in the inline fallback", async () => {
      const result = await registry.getCompiledChat(
        "test-prompt",
        {
          topic: "Workflow Trends",
          network: "X",
        },
        {
          systemPrompt: "You are an expert on {topic}.",
          userPrompt: "Write a {network} post about {topic}.",
        },
      );

      expect(result.systemPrompt).toBe("You are an expert on Workflow Trends.");
      expect(result.userPrompt).toBe("Write a X post about Workflow Trends.");
      expect(result.promptReference).toMatchObject({
        name: "test-prompt",
        label: "0.4.0",
        isFallback: true,
      });
      expect(result.promptReference?.fallbackDigest).toMatch(/^[a-f0-9]{64}$/);
      expect(result.promptReference).not.toHaveProperty("version");
      expect(result.promptReference).not.toHaveProperty("nativePrompt");
    });

    it("leaves unmatched placeholders intact", async () => {
      const result = await registry.getCompiledChat(
        "test-prompt",
        {
          topic: "Product cycle",
        },
        {
          systemPrompt: "You are an expert on {topic}.",
          userPrompt: "Write about {missingVar}.",
        },
      );

      expect(result.systemPrompt).toBe("You are an expert on Product cycle.");
      expect(result.userPrompt).toBe("Write about {missingVar}.");
    });

    it("throws when no fallback is provided and Langfuse is not configured", async () => {
      await expect(registry.getCompiledChat("nonexistent", {})).rejects.toThrow(/not found/);
    });
  });

  describe("getCompiledText (no Langfuse — inline fallback)", () => {
    it("interpolates {var} placeholders in the inline fallback", async () => {
      const result = await registry.getCompiledText(
        "test-prompt",
        {
          network: "X",
          charLimit: "280",
        },
        "Critique this {network} post. Limit: {charLimit} chars.",
      );

      expect(result).toBe("Critique this X post. Limit: 280 chars.");
    });

    it("throws when no fallback is provided and Langfuse is not configured", async () => {
      await expect(registry.getCompiledText("nonexistent", {})).rejects.toThrow(/not found/);
    });
  });

  describe("label resolution", () => {
    it("uses PROMPT_VERSION env var when no per-prompt override is set", async () => {
      const langfuse = createMockLangfuse({ label: "0.4.0" });
      registry = new PromptRegistry(configService, langfuse as unknown as LangfuseService, []);

      const result = await registry.getCompiledChat(
        "test-prompt",
        { topic: "Product Cycle" },
        undefined,
      );

      expect(result.label).toBe("0.4.0");
      expect(result.isFallback).toBe(false);
      expect(result.promptReference).toMatchObject({
        name: "test-prompt",
        label: "0.4.0",
        version: 1,
        isFallback: false,
      });
      expect(langfuse.getChatPrompt).toHaveBeenCalledWith("test-prompt", undefined, "0.4.0");
    });

    it("prefers PROMPT_VERSION_<NAME> over PROMPT_VERSION", async () => {
      const langfuse = createMockLangfuse({ label: "experimental" });
      configService = createMockConfigService({
        PROMPT_VERSION: "0.4.0",
        PROMPT_VERSION_TEST_PROMPT: "experimental",
      });
      registry = new PromptRegistry(configService, langfuse as unknown as LangfuseService, []);

      await registry.getCompiledChat("test-prompt", { topic: "Product Cycle" }, undefined);

      expect(langfuse.getChatPrompt).toHaveBeenCalledWith("test-prompt", undefined, "experimental");
    });

    it("uses explicit label parameter when provided", async () => {
      const langfuse = createMockLangfuse({ label: "v2" });
      configService = createMockConfigService({ PROMPT_VERSION: "0.4.0" });
      registry = new PromptRegistry(configService, langfuse as unknown as LangfuseService, []);

      await registry.getCompiledChat("test-prompt", { topic: "Product Cycle" }, undefined, "v2");

      expect(langfuse.getChatPrompt).toHaveBeenCalledWith("test-prompt", undefined, "v2");
    });
  });

  describe("label fallback chain", () => {
    it("falls back to production when the resolved label is missing", async () => {
      const langfuse = createMockLangfuse({
        responses: [
          { label: "0.4.0", exists: false },
          { label: "production", exists: true, isFallback: false },
        ],
      });
      configService = createMockConfigService({ PROMPT_VERSION: "0.4.0" });
      registry = new PromptRegistry(configService, langfuse as unknown as LangfuseService, []);

      const result = await registry.getCompiledChat(
        "test-prompt",
        { topic: "Product Cycle" },
        undefined,
      );

      expect(result.label).toBe("production");
      expect(result.isFallback).toBe(false);
      expect(langfuse.getChatPrompt).toHaveBeenCalledTimes(2);
      expect(langfuse.getChatPrompt).toHaveBeenNthCalledWith(1, "test-prompt", undefined, "0.4.0");
      expect(langfuse.getChatPrompt).toHaveBeenNthCalledWith(
        2,
        "test-prompt",
        undefined,
        "production",
      );
    });

    it("uses inline fallback when all labels are missing", async () => {
      const langfuse = createMockLangfuse({ responses: [] });
      registry = new PromptRegistry(configService, langfuse as unknown as LangfuseService, []);

      const result = await registry.getCompiledChat(
        "test-prompt",
        { topic: "Product Cycle" },
        {
          systemPrompt: "System {topic}",
          userPrompt: "User {topic}",
        },
      );

      expect(result.systemPrompt).toBe("System Product Cycle");
      expect(result.userPrompt).toBe("User Product Cycle");
      expect(result.label).toBe("0.4.0");
      expect(result.isFallback).toBe(true);
      expect(result.promptReference).toMatchObject({
        name: "test-prompt",
        label: "0.4.0",
        isFallback: true,
      });
      expect(result.promptReference?.fallbackDigest).toMatch(/^[a-f0-9]{64}$/);
      expect(result.promptReference).not.toHaveProperty("version");
      expect(result.promptReference).not.toHaveProperty("nativePrompt");
    });
  });

  describe("EVAL-103 native prompt identity", () => {
    it("exposes one exact reference for direct single-prompt callers", async () => {
      const langfuse = createMockLangfuse({
        responses: [{ label: "production", exists: true, isFallback: false, version: 6 }],
      });
      registry = new PromptRegistry(configService, langfuse as unknown as LangfuseService, []);

      const compiled = await registry.getCompiledText(
        "orchestrator-system",
        {},
        undefined,
        "production",
      );

      expect(registry.consumePromptReference("", compiled)).toMatchObject({
        name: "orchestrator-system",
        label: "production",
        version: 6,
        isFallback: false,
      });
      expect(registry.consumePromptReference("", compiled)).toBeUndefined();
    });

    it("preserves each fetched client and concrete version for its exact compiled call", async () => {
      const langfuse = createMockLangfuse({
        responses: [
          { label: "production", exists: true, isFallback: false, version: 7 },
          { label: "candidate", exists: true, isFallback: false, version: 12 },
        ],
      });
      registry = new PromptRegistry(configService, langfuse as unknown as LangfuseService, []);

      await withPromptLabelContext(async () => {
        const research = await registry.getCompiledChat(
          "research-extract",
          {},
          undefined,
          "production",
        );
        const draft = await registry.getCompiledChat("draft-post", {}, undefined, "candidate");

        const researchReference = consumePromptReference(
          research.systemPrompt,
          research.userPrompt,
        );
        const draftReference = consumePromptReference(draft.systemPrompt, draft.userPrompt);

        expect(researchReference).toMatchObject({
          name: "research-extract",
          label: "production",
          version: 7,
          isFallback: false,
        });
        expect(draftReference).toMatchObject({
          name: "draft-post",
          label: "candidate",
          version: 12,
          isFallback: false,
        });
        expect(researchReference?.nativePrompt).toBe(research.promptReference?.nativePrompt);
        expect(draftReference?.nativePrompt).toBe(draft.promptReference?.nativePrompt);
        expect(researchReference?.nativePrompt).not.toBe(draftReference?.nativePrompt);
      });
    });

    it("keeps the same native reference through the compiled prompt cache", async () => {
      const langfuse = createMockLangfuse({
        responses: [{ label: "production", exists: true, isFallback: false, version: 9 }],
      });
      registry = new PromptRegistry(configService, langfuse as unknown as LangfuseService, []);

      await withPromptLabelContext(async () => {
        const first = await registry.getCompiledChat(
          "hook-generation",
          {},
          undefined,
          "production",
        );
        const cached = await registry.getCompiledChat(
          "hook-generation",
          {},
          undefined,
          "production",
        );

        expect(langfuse.getChatPrompt).toHaveBeenCalledOnce();
        expect(cached.promptReference?.nativePrompt).toBe(first.promptReference?.nativePrompt);
        expect(consumePromptReference(first.systemPrompt, first.userPrompt)?.version).toBe(9);
        expect(consumePromptReference(cached.systemPrompt, cached.userPrompt)?.version).toBe(9);
      });
    });

    it("records text fallback label and deterministic digest without remote identity", async () => {
      const fallback = "Sensitive fallback template for {network}";

      await withPromptLabelContext(async () => {
        const first = await registry.getCompiledText(
          "critique-post",
          { network: "X" },
          fallback,
          "production",
        );
        const firstReference = consumePromptReference("", first);
        const second = await registry.getCompiledText(
          "critique-post",
          { network: "X" },
          fallback,
          "production",
        );
        const secondReference = consumePromptReference("", second);

        expect(firstReference).toMatchObject({
          name: "critique-post",
          label: "production",
          isFallback: true,
        });
        expect(firstReference?.fallbackDigest).toMatch(/^[a-f0-9]{64}$/);
        expect(secondReference?.fallbackDigest).toBe(firstReference?.fallbackDigest);
        expect(firstReference).not.toHaveProperty("version");
        expect(firstReference).not.toHaveProperty("nativePrompt");
        expect(JSON.stringify(firstReference)).not.toContain(fallback);
      });
    });

    it("keeps an SDK fallback client unlinked even when it exposes version zero", async () => {
      const langfuse = createMockLangfuse({
        responses: [{ label: "latest", exists: true, isFallback: true, version: 0 }],
      });
      registry = new PromptRegistry(configService, langfuse as unknown as LangfuseService, []);

      const result = await registry.getCompiledChat(
        "draft-post",
        {},
        { systemPrompt: "Fallback system", userPrompt: "Fallback user" },
      );

      expect(result.promptReference).toMatchObject({
        name: "draft-post",
        label: "latest",
        isFallback: true,
      });
      expect(result.promptReference?.fallbackDigest).toMatch(/^[a-f0-9]{64}$/);
      expect(result.promptReference).not.toHaveProperty("version");
      expect(result.promptReference).not.toHaveProperty("nativePrompt");
    });
  });
});

// ── Mock helpers ───────────────────────────────────────────────────────────

function createMockLangfuse({
  label = "0.4.0",
  responses,
}: {
  label?: string;
  responses?: Array<{
    label: string;
    exists: boolean;
    isFallback?: boolean;
    version?: number;
  }>;
} = {}) {
  const callLog: { label: string; fallback: unknown }[] = [];

  const getChatPrompt = vi.fn(async (name: string, fallback: unknown, promptLabel: string) => {
    callLog.push({ label: promptLabel, fallback });

    const response = responses
      ? (responses.find((r) => r.label === promptLabel) ?? { exists: false })
      : { exists: true, isFallback: false };

    if (!response.exists) {
      return undefined;
    }

    return {
      name,
      version: response.version ?? 1,
      isFallback: response.isFallback ?? false,
      compile: (_vars: Record<string, string>) => [
        { role: "system", content: `${name} system` },
        { role: "user", content: `${name} user` },
      ],
    };
  });

  const getTextPrompt = vi.fn(async (name: string, fallback: unknown, promptLabel: string) => {
    callLog.push({ label: promptLabel, fallback });

    const response = responses
      ? (responses.find((r) => r.label === promptLabel) ?? { exists: false })
      : { exists: true, isFallback: false };

    if (!response.exists) {
      return undefined;
    }

    return {
      name,
      version: response.version ?? 1,
      isFallback: response.isFallback ?? false,
      compile: (_vars: Record<string, string>) => `${name} text`,
    };
  });

  return { getChatPrompt, getTextPrompt, callLog };
}
