/**
 * Sprint O / F19: Quote Card Service — generate image quote cards from post content.
 *
 * Uses Satori to render JSX → SVG, then converts to PNG via @resvg/resvg-js.
 * Images are saved to the content directory and can be attached to posts.
 *
 * Env-gated: only active when QUOTE_CARDS_ENABLED=true.
 */
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { promises as fs } from 'fs';
import { join } from 'path';
import { parseBool } from '../../infrastructure/config/parse-bool.js';

@Injectable()
export class QuoteCardService {
  private readonly logger = new Logger(QuoteCardService.name);
  private readonly enabled: boolean;
  private readonly outputDir: string;
  private readonly width: number;
  private readonly height: number;
  // QC1: Satori requires real font data (it does NOT fall back to system fonts).
  // Lazily load + cache the bundled Inter subset (latin) once per process.
  private fontsCache:
    | Array<{ name: 'Inter'; data: Buffer; weight: 400 | 600; style: 'normal' | 'italic' }>
    | null = null;

  constructor(private readonly configService: ConfigService) {
    this.enabled = parseBool(this.configService.get<string>('QUOTE_CARDS_ENABLED', 'false'));
    this.outputDir = this.configService.get<string>('QUOTE_CARDS_DIR', '/app/quote-cards');
    this.width = this.configService.get<number>('QUOTE_CARD_WIDTH', 1200);
    this.height = this.configService.get<number>('QUOTE_CARD_HEIGHT', 675);
  }

  /**
   * QC1: load the bundled Inter font subset Satori needs (400/600 normal + 400
   * italic — matching the card's quote weight and italic author line). Resolved
   * via `require.resolve` so it works regardless of node_modules layout (pnpm,
   * Docker). Cached after first use.
   */
  private async loadFonts(): Promise<
    Array<{ name: 'Inter'; data: Buffer; weight: 400 | 600; style: 'normal' | 'italic' }>
  > {
    if (this.fontsCache) return this.fontsCache;
    const read = (file: string): Promise<Buffer> =>
      fs.readFile(require.resolve(`@fontsource/inter/files/${file}`));
    const [normal, semibold, italic] = await Promise.all([
      read('inter-latin-400-normal.woff'),
      read('inter-latin-600-normal.woff'),
      read('inter-latin-400-italic.woff'),
    ]);
    this.fontsCache = [
      { name: 'Inter', data: normal, weight: 400, style: 'normal' },
      { name: 'Inter', data: semibold, weight: 600, style: 'normal' },
      { name: 'Inter', data: italic, weight: 400, style: 'italic' },
    ];
    return this.fontsCache;
  }

  /**
   * Generate a quote card image from text content.
   * Returns the file path of the generated PNG, or null if disabled.
   */
  async generateQuoteCard(
    text: string,
    options?: { author?: string; network?: string; bgGradient?: [string, string] },
  ): Promise<string | null> {
    if (!this.enabled) {
      this.logger.debug('Quote cards disabled — skipping');
      return null;
    }

    try {
      // Dynamic import to avoid loading Satori if not enabled
      const { default: satori } = await import('satori');
      const { Resvg } = await import('@resvg/resvg-js');

      // Ensure output directory exists
      await fs.mkdir(this.outputDir, { recursive: true });

      // Build the SVG via Satori
      const bg = options?.bgGradient ?? ['#1a1a2e', '#16213e'];
      const author = options?.author ?? 'Cosmic Insights';

      const svg = await satori(
        {
          type: 'div',
          props: {
            style: {
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              justifyContent: 'center',
              width: '100%',
              height: '100%',
              background: `linear-gradient(135deg, ${bg[0]}, ${bg[1]})`,
              padding: 60,
              fontFamily: 'Inter',
            },
            children: [
              {
                type: 'div',
                props: {
                  style: {
                    fontSize: 42,
                    color: '#ffffff',
                    textAlign: 'center',
                    lineHeight: 1.4,
                    maxWidth: '90%',
                    fontWeight: 600,
                  },
                  children: this.truncateForCard(text),
                },
              },
              {
                type: 'div',
                props: {
                  style: {
                    marginTop: 30,
                    fontSize: 24,
                    color: 'rgba(255,255,255,0.6)',
                    fontStyle: 'italic',
                  },
                  children: `— ${author}`,
                },
              },
            ],
          },
        },
        {
          width: this.width,
          height: this.height,
          fonts: await this.loadFonts(),
        },
      );

      // Convert SVG to PNG
      const resvg = new Resvg(svg, {
        fitTo: { mode: 'width', value: this.width },
      });
      const pngBuffer = resvg.render().asPng();

      // Save to file
      const filename = `quote-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.png`;
      const filepath = join(this.outputDir, filename);
      await fs.writeFile(filepath, pngBuffer);

      // Clean up old quote cards (older than 7 days) to prevent disk fill
      this.cleanupOldCards(7).catch((err) =>
        this.logger.warn(`Quote card cleanup failed: ${(err as Error).message}`),
      );

      this.logger.log(`Quote card generated: ${filepath}`);
      return filepath;
    } catch (err) {
      this.logger.error(`Quote card generation failed: ${(err as Error).message}`);
      return null;
    }
  }

  /**
   * Truncate text to fit on a quote card (max ~200 chars).
   */
  private truncateForCard(text: string): string {
    const clean = text.replace(/\n/g, ' ').trim();
    if (clean.length <= 200) return clean;
    return clean.slice(0, 197) + '...';
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  getOutputDir(): string {
    return this.outputDir;
  }

  /**
   * Delete quote card PNG files older than maxAgeDays to prevent disk fill.
   * Called opportunistically after each generation (fire-and-forget).
   */
  private async cleanupOldCards(maxAgeDays: number): Promise<void> {
    try {
      const files = await fs.readdir(this.outputDir);
      const now = Date.now();
      const maxAgeMs = maxAgeDays * 24 * 60 * 60 * 1000;

      for (const file of files) {
        if (!file.endsWith('.png')) continue;
        const filepath = join(this.outputDir, file);
        const stat = await fs.stat(filepath);
        if (now - stat.mtimeMs > maxAgeMs) {
          await fs.unlink(filepath);
          this.logger.debug(`Cleaned up old quote card: ${file}`);
        }
      }
    } catch {
      // Directory may not exist yet — ignore
    }
  }
}
