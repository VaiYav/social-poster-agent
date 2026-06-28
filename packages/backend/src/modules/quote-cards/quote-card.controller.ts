/**
 * Sprint O / F19: Quote Card Controller — REST endpoints for quote card generation.
 */
import { Controller, Post, Body, Res, HttpStatus, UseGuards } from '@nestjs/common';
import type { Response } from 'express';
import { QuoteCardService } from './quote-card.service';
import { LocalhostGuard } from '../../infrastructure/guards/localhost.guard';
import { promises as fs } from 'fs';

@Controller('quote-cards')
export class QuoteCardController {
  constructor(private readonly quoteCardService: QuoteCardService) {}

  @Post('generate')
  @UseGuards(LocalhostGuard) // Triggers image generation + disk writes — restrict to localhost
  async generate(
    @Body() body: { text: string; author?: string; network?: string },
    @Res({ passthrough: true }) res: Response,
  ) {
    if (!this.quoteCardService.isEnabled()) {
      res.status(HttpStatus.SERVICE_UNAVAILABLE);
      return { error: 'Quote cards disabled' };
    }

    const filepath = await this.quoteCardService.generateQuoteCard(body.text, {
      author: body.author,
      network: body.network,
    });

    if (!filepath) {
      res.status(HttpStatus.INTERNAL_SERVER_ERROR);
      return { error: 'Generation failed' };
    }

    // Stream the file back
    const buffer = await fs.readFile(filepath);
    res.setHeader('Content-Type', 'image/png');
    res.setHeader('Content-Disposition', 'attachment; filename="quote-card.png"');
    return buffer;
  }
}
