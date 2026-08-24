export const IImagePort = Symbol("IImagePort");

export type ImageResolution = "0.5K" | "1K" | "2K" | "4K";

export interface ImageGenerateOptions {
  readonly prompt: string;
  readonly negativePrompt?: string;
  readonly model: string;
  readonly resolution: ImageResolution;
  readonly aspectRatio: string;
  readonly accountId: string;
}

export interface GeneratedImage {
  readonly buffer: Buffer;
  readonly mimeType: string;
  readonly costUsd: number;
}

export interface IImagePort {
  generate(options: ImageGenerateOptions): Promise<GeneratedImage>;
}
