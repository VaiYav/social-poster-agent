import { Global, Module } from "@nestjs/common";
import { PrismaModule } from "../../infrastructure/prisma/prisma.module.js";
import { RedisModule } from "../../infrastructure/redis/redis.module.js";
import { AccountsModule } from "../accounts/accounts.module.js";
import { ImageGenerationService } from "./image-generation.service.js";
import { ImageQuotaService } from "./image-quota.service.js";
import { GeminiImageService } from "../../infrastructure/image/gemini-image.service.js";
import { IImagePort } from "../../domain/ports/image.port.js";

@Global()
@Module({
  imports: [PrismaModule, RedisModule, AccountsModule],
  providers: [
    ImageQuotaService,
    GeminiImageService,
    ImageGenerationService,
    { provide: IImagePort, useExisting: GeminiImageService },
  ],
  exports: [ImageQuotaService, ImageGenerationService, GeminiImageService, IImagePort],
})
export class MediaModule {}
