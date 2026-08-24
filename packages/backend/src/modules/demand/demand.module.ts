import { Global, Module } from "@nestjs/common";
import { DemandRadarController } from "./demand-radar.controller.js";
import { DemandRadarService } from "./demand-radar.service.js";
import { DemandSignalExtractor } from "./demand-signal-extractor.js";

@Global()
@Module({
  providers: [DemandRadarService, DemandSignalExtractor],
  controllers: [DemandRadarController],
  exports: [DemandRadarService],
})
export class DemandModule {}
