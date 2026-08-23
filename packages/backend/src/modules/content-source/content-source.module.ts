import { Module } from "@nestjs/common";
import { ContentModule } from "../../infrastructure/content/content.module.js";
import { ContentSourceService } from "./content-source.service.js";
import { ContentSourceController } from "./content-source.controller.js";

@Module({
  imports: [ContentModule],
  providers: [ContentSourceService],
  controllers: [ContentSourceController],
  exports: [ContentSourceService],
})
export class ContentSourceModule {}
