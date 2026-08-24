import { Module } from "@nestjs/common";
import { TelegramAdapter } from "./telegram.adapter.js";

/**
 * TelegramModule — provides the TelegramAdapter for posting via the Bot API.
 *
 * Imported by SyndicationModule when SYNDICATION_ENABLED=true.
 */
@Module({
  providers: [TelegramAdapter],
  exports: [TelegramAdapter],
})
export class TelegramModule {}
