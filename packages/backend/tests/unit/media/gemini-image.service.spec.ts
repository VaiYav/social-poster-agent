import { afterEach, describe, expect, it, vi } from "vitest";
import { GeminiImageService } from "../../../src/infrastructure/image/gemini-image.service.js";

const options = {
  prompt: "A blue abstract morning composition",
  negativePrompt: "No text",
  model: "gemini-3.1-flash-lite-image",
  resolution: "2K" as const,
  aspectRatio: "16:9",
  accountId: "account-1",
};

describe("MEDIA-101 GeminiImageService", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("sends the official REST shape and clamps Lite output to 1K", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          candidates: [
            { content: { parts: [{ inlineData: { mimeType: "image/png", data: "aGVsbG8=" } }] } },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);
    const service = new GeminiImageService({
      get: vi.fn((key: string, fallback?: string) =>
        key === "GEMINI_API_KEY" ? "secret-key" : fallback,
      ),
    } as never);

    const result = await service.generate(options);
    const request = JSON.parse(fetchMock.mock.calls[0]![1].body as string) as {
      generationConfig: {
        responseModalities: string[];
        responseFormat: { image: { imageSize: string } };
      };
    };

    expect(result).toMatchObject({ mimeType: "image/png", costUsd: 0.0336 });
    expect(Buffer.from(result.buffer).toString()).toBe("hello");
    expect(fetchMock.mock.calls[0]![0]).toBe(
      "https://generativelanguage.googleapis.com/v1/models/gemini-3.1-flash-lite-image:generateContent",
    );
    expect(fetchMock.mock.calls[0]![1].headers["x-goog-api-key"]).toBe("secret-key");
    expect(request.generationConfig.responseModalities).toEqual(["IMAGE"]);
    expect(request.generationConfig.responseFormat.image.imageSize).toBe("1K");
  });

  it("fails closed when the response contains no image part", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({ candidates: [{ content: { parts: [{ text: "no image" }] } }] }),
          {
            status: 200,
          },
        ),
      ),
    );
    const service = new GeminiImageService({ get: vi.fn().mockReturnValue("secret-key") } as never);

    await expect(service.generate(options)).rejects.toThrow("inline image");
  });
});
