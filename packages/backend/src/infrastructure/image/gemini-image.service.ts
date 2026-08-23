import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import type {
  GeneratedImage,
  IImagePort,
  ImageGenerateOptions,
} from "../../domain/ports/image.port.js";

const GEMINI_ENDPOINT = "https://generativelanguage.googleapis.com/v1/models";
const LITE_MODEL = "gemini-3.1-flash-lite-image";
const MODEL_COST_USD: Record<string, number> = {
  "gemini-3.1-flash-lite-image": 0.0336,
  "gemini-3.1-flash-image": 0.067,
  "gemini-3.0-pro-image": 0.134,
};

interface GeminiResponse {
  candidates?: Array<{
    content?: {
      parts?: Array<{
        inlineData?: { mimeType?: string; data?: string };
        inline_data?: { mime_type?: string; data?: string };
      }>;
    };
  }>;
  error?: { message?: string };
}

@Injectable()
export class GeminiImageService implements IImagePort {
  private readonly apiKey: string;
  private readonly timeoutMs: number;

  constructor(config: ConfigService) {
    this.apiKey =
      config.get<string>("GEMINI_API_KEY", "") || config.get<string>("GOOGLE_API_KEY", "");
    const timeout = Number(config.get<string>("IMAGE_GENERATION_TIMEOUT_MS", "90000"));
    this.timeoutMs = Number.isFinite(timeout) && timeout > 0 ? timeout : 90_000;
  }

  async generate(options: ImageGenerateOptions): Promise<GeneratedImage> {
    if (!this.apiKey) throw new Error("GEMINI_API_KEY is not configured");
    const model = options.model || LITE_MODEL;
    const imageSize =
      model === LITE_MODEL && options.resolution !== "1K"
        ? "1K"
        : options.resolution === "0.5K"
          ? "512"
          : options.resolution;
    const prompt = options.negativePrompt
      ? `${options.prompt}\n\nNegative prompt: ${options.negativePrompt}`
      : options.prompt;
    const response = await fetch(
      `${GEMINI_ENDPOINT}/${encodeURIComponent(model)}:generateContent`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-goog-api-key": this.apiKey,
        },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: {
            responseModalities: ["IMAGE"],
            responseFormat: {
              image: { aspectRatio: options.aspectRatio, imageSize },
            },
          },
        }),
        signal: AbortSignal.timeout(this.timeoutMs),
      },
    );
    const payload = (await response.json()) as GeminiResponse;
    if (!response.ok) {
      throw new Error(payload.error?.message ?? `Gemini image request failed (${response.status})`);
    }
    const part = payload.candidates
      ?.flatMap((candidate) => candidate.content?.parts ?? [])
      .find((candidatePart) => candidatePart.inlineData?.data || candidatePart.inline_data?.data);
    const data = part?.inlineData?.data ?? part?.inline_data?.data;
    const mimeType = part?.inlineData?.mimeType ?? part?.inline_data?.mime_type;
    if (!data || !mimeType?.startsWith("image/")) {
      throw new Error("Gemini response did not contain an inline image");
    }
    return {
      buffer: Buffer.from(data, "base64"),
      mimeType,
      costUsd: MODEL_COST_USD[model] ?? MODEL_COST_USD[LITE_MODEL]!,
    };
  }
}
