import { Inject, Injectable, Logger, Optional } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { PrismaService } from "../../infrastructure/prisma/prisma.service.js";
import { AccountSettingsService } from "../accounts/account-settings.service.js";
import { IImagePort, type ImageResolution } from "../../domain/ports/image.port.js";
import type { VisualConcept } from "../content-enhancements/visual-concept.service.js";
import { ImageQuotaService } from "./image-quota.service.js";

const MODEL_COST_USD: Record<string, number> = {
  "gemini-3.1-flash-lite-image": 0.0336,
  "gemini-3.1-flash-image": 0.067,
  "gemini-3.0-pro-image": 0.134,
};

@Injectable()
export class ImageGenerationService {
  private readonly logger = new Logger(ImageGenerationService.name);
  private readonly enabled: boolean;
  private readonly outputDir: string;
  private readonly defaultModel: string;
  private readonly defaultResolution: ImageResolution;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly quota: ImageQuotaService,
    @Optional() private readonly accountSettings?: AccountSettingsService,
    @Optional()
    @Inject(IImagePort)
    private readonly imagePort?: import("../../domain/ports/image.port.js").IImagePort,
  ) {
    this.enabled = config.get<string>("IMAGE_GENERATION_ENABLED", "false") === "true";
    this.outputDir = config.get<string>("IMAGE_OUTPUT_DIR", "./spa-images");
    this.defaultModel = config.get<string>("IMAGE_GENERATION_MODEL", "gemini-3.1-flash-lite-image");
    const resolution = config.get<string>("IMAGE_GENERATION_RESOLUTION", "1K");
    this.defaultResolution = ["0.5K", "1K", "2K", "4K"].includes(resolution)
      ? (resolution as ImageResolution)
      : "1K";
  }

  async generateForPost(
    postId: string,
    accountId: string,
    concept: VisualConcept,
  ): Promise<{
    generated: boolean;
    media?: Record<string, unknown>;
    skippedReason?: string;
  }> {
    if (!this.enabled) return { generated: false, skippedReason: "disabled" };
    if (!this.imagePort) return { generated: false, skippedReason: "provider_unavailable" };

    const settings = this.accountSettings
      ? await this.accountSettings.resolve(accountId).catch(() => null)
      : null;
    if (settings && !settings.values.imageGenerationEnabled) {
      return { generated: false, skippedReason: "account_disabled" };
    }
    const model = settings?.values.imageModel || this.defaultModel;
    const resolution = (settings?.values.imageResolution ||
      this.defaultResolution) as ImageResolution;
    const estimatedCostUsd =
      MODEL_COST_USD[model] ?? MODEL_COST_USD["gemini-3.1-flash-lite-image"]!;
    const quota = await this.quota.reserve(accountId, estimatedCostUsd, {
      dailyLimit: settings?.values.imageDailyLimit,
      budgetUsd: settings?.values.imageCostBudgetUsdPerDay,
    });
    if (!quota.allowed)
      return { generated: false, skippedReason: quota.reason?.toLowerCase() ?? "quota" };

    try {
      const image = await this.imagePort.generate({
        prompt: concept.imagePrompt,
        negativePrompt:
          "No text, no watermark, no UI elements, no borders, no faces unless explicitly requested.",
        model,
        resolution,
        aspectRatio: aspectRatioFor(concept.network),
        accountId,
      });
      if (!image.mimeType.startsWith("image/") || image.buffer.length === 0) {
        throw new Error("Image provider returned an invalid image payload");
      }
      await mkdir(this.outputDir, { recursive: true });
      const path = join(this.outputDir, `${accountId}_${postId}_${Date.now()}.png`);
      await writeFile(path, image.buffer);
      const media = {
        generated: true,
        generatedBy: "IImagePort",
        model,
        resolution,
        costUsd: image.costUsd,
        path,
        url: `/api/v1/posts/${postId}/media`,
        createdAt: new Date().toISOString(),
      };
      await this.prisma.post.update({ where: { id: postId }, data: { media } });
      return { generated: true, media };
    } catch (error) {
      await this.quota.release(accountId, estimatedCostUsd).catch(() => undefined);
      this.logger.warn(`Image generation failed for ${postId}: ${errorMessage(error)}`);
      return { generated: false, skippedReason: "provider_failed" };
    }
  }
}

function aspectRatioFor(network: string): string {
  if (network === "X") return "16:9";
  if (network === "FACEBOOK") return "1.91:1";
  return "4:5";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
