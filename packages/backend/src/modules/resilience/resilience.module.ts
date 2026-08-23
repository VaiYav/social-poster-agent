import { Global, Module } from "@nestjs/common";
import { ResilienceService } from "./resilience.service.js";
import { IResiliencePort } from "../../domain/ports/resilience.port.js";

/**
 * ResilienceModule — unified degradation model (ROADMAP_V2 M1.5/M3).
 * Global so every subsystem can report health without creating dependency
 * cycles or coupling callers to the concrete implementation.
 */
@Global()
@Module({
  providers: [ResilienceService, { provide: IResiliencePort, useExisting: ResilienceService }],
  exports: [ResilienceService, IResiliencePort],
})
export class ResilienceModule {}
