/**
 * Sprint O / F19: Quote Card Controller — REST endpoints for quote card generation.
 */
import {
  Controller,
  Post,
  Get,
  Body,
  Query,
  Res,
  HttpStatus,
  UseGuards,
  NotFoundException,
  BadRequestException,
} from "@nestjs/common";
import type { Response } from "express";
import { QuoteCardService } from "./quote-card.service";
import { LocalhostGuard } from "../../infrastructure/guards/localhost.guard";
import { promises as fs } from "fs";
import { resolve, relative } from "path";

interface GenerateQuoteCardBody {
  text: string;
  author?: string;
  network?: string;
  bgGradient?: [string, string];
}

const networkGradients: Record<string, [string, string]> = {
  X: ["#1a1a2e", "#16213e"],
  THREADS: ["#0f0f23", "#1a1a3e"],
  FACEBOOK: ["#1e3a8a", "#1e40af"],
};

@Controller("quote-cards")
export class QuoteCardController {
  constructor(private readonly quoteCardService: QuoteCardService) {}

  @Post("generate")
  @UseGuards(LocalhostGuard) // Triggers image generation + disk writes — restrict to localhost
  async generate(@Body() body: GenerateQuoteCardBody, @Res({ passthrough: true }) res: Response) {
    if (!this.quoteCardService.isEnabled()) {
      res.status(HttpStatus.SERVICE_UNAVAILABLE);
      return { path: null, error: "Quote cards disabled" };
    }

    const gradient = body.bgGradient ?? (body.network ? networkGradients[body.network] : undefined);
    const filepath = await this.quoteCardService.generateQuoteCard(body.text, {
      author: body.author,
      network: body.network,
      bgGradient: gradient,
    });

    if (!filepath) {
      res.status(HttpStatus.INTERNAL_SERVER_ERROR);
      return { path: null, error: "Generation failed" };
    }

    return { path: filepath };
  }

  @Get("file")
  async getFile(@Query("path") rawPath: string, @Res({ passthrough: true }) res: Response) {
    if (!rawPath) {
      throw new BadRequestException("Missing path");
    }

    const outputDir = this.quoteCardService.getOutputDir();
    const requested = resolve(outputDir, rawPath);
    const rel = relative(outputDir, requested);
    if (rel.startsWith("..") || rel.startsWith("/")) {
      throw new NotFoundException("Invalid path");
    }

    try {
      const buffer = await fs.readFile(requested);
      res.setHeader("Content-Type", "image/png");
      res.setHeader("Content-Disposition", 'inline; filename="quote-card.png"');
      return buffer;
    } catch {
      throw new NotFoundException("File not found");
    }
  }
}
