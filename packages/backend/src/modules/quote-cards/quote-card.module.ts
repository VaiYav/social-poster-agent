/**
 * Sprint O / F19: Quote Card Module.
 */
import { Module } from "@nestjs/common";
import { QuoteCardService } from "./quote-card.service.js";
import { QuoteCardController } from "./quote-card.controller.js";

@Module({
  controllers: [QuoteCardController],
  providers: [QuoteCardService],
})
export class QuoteCardModule {}
