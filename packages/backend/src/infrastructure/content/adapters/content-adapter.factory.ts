import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as fs from 'node:fs';
import { join } from 'node:path';
import { ContentSourcesConfigSchema, type ContentSourceConfig } from '@spa/shared';
import type { ContentReader } from '../content-reader.js';
import type { DbContentReader } from '../db-content-reader.js';
import type { PrismaService } from '../../prisma/prisma.service';
import type { IContentAdapter } from './content-adapter.interface.js';
import { ApiAdapter } from './api.adapter.js';
import { GoogleTrendsAdapter } from './google-trends.adapter.js';
import { RssAdapter } from './rss.adapter.js';

export interface ContentAdapterFactoryDeps {
  configService: ConfigService;
  prisma?: PrismaService;
  fsReader: ContentReader;
  dbReader: DbContentReader;
}

/**
 * Build the list of IContentAdapter implementations to register.
 *
 * 1. Query `ContentSource` table for enabled rows (primary source of truth).
 * 2. If none, read `CONTENT_SOURCES` env var (JSON) for backward compatibility.
 * 3. If still empty, fall back to legacy auto-detection:
 *    CAP filesystem reader if `CONTENT_AGENT_PLATFORM_PATH` exists, otherwise
 *    the DB-backed reader.
 */
export async function buildContentAdapters(deps: ContentAdapterFactoryDeps): Promise<IContentAdapter[]> {
  const logger = new Logger('ContentAdapterFactory');

  const fromDb = await dbSources(deps, logger);
  if (fromDb.length > 0) return fromDb;

  const fromEnv = envSources(deps, logger);
  if (fromEnv.length > 0) return fromEnv;

  return legacyAdapters(deps);
}

async function dbSources(deps: ContentAdapterFactoryDeps, logger: Logger): Promise<IContentAdapter[]> {
  if (!deps.prisma?.contentSource) return [];
  try {
    const rows = await deps.prisma.contentSource.findMany({
      where: { enabled: true },
      orderBy: [{ priority: 'asc' }, { createdAt: 'asc' }],
    });
    const adapters: IContentAdapter[] = [];
    for (const row of rows) {
      const source: ContentSourceConfig = {
        sourceType: row.sourceType,
        name: row.name ?? undefined,
        enabled: row.enabled,
        config: (typeof row.config === 'object' && row.config !== null ? row.config : {}) as Record<string, unknown>,
      };
      const adapter = createAdapter(source, deps);
      if (adapter) adapters.push(adapter);
    }
    if (adapters.length > 0) {
      logger.debug(`Loaded ${adapters.length} content adapter(s) from ContentSource table`);
    }
    return adapters;
  } catch (err) {
    logger.warn(`ContentSource DB read failed: ${(err as Error).message}. Falling back to env/legacy.`);
    return [];
  }
}

function envSources(deps: ContentAdapterFactoryDeps, logger: Logger): IContentAdapter[] {
  const sourcesJson = deps.configService.get<string>('CONTENT_SOURCES', '').trim();
  if (!sourcesJson) return [];
  try {
    const parsed = JSON.parse(sourcesJson) as unknown;
    const sources = ContentSourcesConfigSchema.parse(parsed);
    const adapters: IContentAdapter[] = [];
    for (const source of sources) {
      if (source.enabled === false) continue;
      const adapter = createAdapter(source, deps);
      if (adapter) adapters.push(adapter);
    }
    if (adapters.length > 0) {
      logger.debug(`Loaded ${adapters.length} content adapter(s) from CONTENT_SOURCES env`);
    }
    return adapters;
  } catch (err) {
    logger.warn(`CONTENT_SOURCES parse failed: ${(err as Error).message}. Falling back to legacy detection.`);
    return [];
  }
}

const ADAPTER_FACTORIES: Record<
  string,
  (source: ContentSourceConfig, deps: ContentAdapterFactoryDeps) => IContentAdapter | null
> = {
  'cap_file': (_source, deps) => deps.fsReader,
  'db': (_source, deps) => deps.dbReader,
  'rss': (source) => new RssAdapter(source),
  'api': (source) => new ApiAdapter(source),
  'google_trends': (source) => new GoogleTrendsAdapter(source),
  'google-trends': (source) => new GoogleTrendsAdapter(source),
};

function createAdapter(source: ContentSourceConfig, deps: ContentAdapterFactoryDeps): IContentAdapter | null {
  const factory = ADAPTER_FACTORIES[source.sourceType];
  return factory ? factory(source, deps) : null;
}

function legacyAdapters(deps: ContentAdapterFactoryDeps): IContentAdapter[] {
  const capPath = deps.configService.get<string>('CONTENT_AGENT_PLATFORM_PATH', '');
  if (capPath) {
    if (fs.existsSync(join(capPath, 'runs'))) {
      return [deps.fsReader];
    }
  }
  return [deps.dbReader];
}
