import { Logger } from '@nestjs/common';
import { ok, err, type Result } from '../../domain/result.js';

export interface NamedCollector<T = unknown> {
  name: string;
  collect(): Promise<T> | T;
}

/**
 * CollectorPipeline — runs a set of named collectors in parallel,
 * captures each result or error as a Result<T>, and returns a map
 * of name → Result.
 *
 * Partial failures don't abort other collectors; degrades are tracked
 * so the caller can decide how to combine them.
 */
export class CollectorPipeline {
  private readonly logger = new Logger(CollectorPipeline.name);

  async run<T extends Record<string, unknown>>(
    collectors: { [K in keyof T]: NamedCollector<T[K]> },
  ): Promise<{ [K in keyof T]: Result<T[K], Error> }> {
    const names = Object.keys(collectors) as (keyof T)[];
    const entries = await Promise.all(
      names.map(async (name) => {
        const collector = collectors[name];
        if (!collector) {
          return [name, err(new Error(`Collector ${String(name)} is undefined`))] as const;
        }
        try {
          const value = await collector.collect();
          return [name, ok(value)] as const;
        } catch (error) {
          const e = error instanceof Error ? error : new Error(String(error));
          this.logger.warn(`Collector ${String(name)} degraded: ${e.message}`);
          return [name, err(e)] as const;
        }
      }),
    );

    return Object.fromEntries(entries) as { [K in keyof T]: Result<T[K], Error> };
  }
}
