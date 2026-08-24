import { Module } from "@nestjs/common";

import { ILinkPort } from "../../domain/ports/link.port.js";
import { ZodiacLinkClient } from "./zodiac-link.client.js";

/**
 * LinkModule — lead-attribution HTTP adapter (ROADMAP_V2 Z4).
 * Binds the ILinkPort domain port to ZodiacLinkClient; consumers inject
 * `@Inject(ILinkPort)` so tests can substitute a fake.
 */
@Module({
  providers: [ZodiacLinkClient, { provide: ILinkPort, useExisting: ZodiacLinkClient }],
  exports: [ZodiacLinkClient, ILinkPort],
})
export class LinkModule {}
