import type IORedis from "ioredis";
import { isLlmResponse, type LlmResponse } from "../../domain/ports/llm.port.js";

export interface LlmCache {
  get(key: string): Promise<LlmResponse | null>;
  set(key: string, response: LlmResponse, ttlMs: number): Promise<void>;
  clear(): Promise<void>;
  stats(): Promise<{ size: number }>;
}

interface InMemoryCacheEntry {
  response: LlmResponse;
  expiresAt: number;
}

export class InMemoryLlmCache implements LlmCache {
  private readonly cache = new Map<string, InMemoryCacheEntry>();

  constructor(
    private readonly maxSize: number,
    private readonly ttlMs: number,
  ) {}

  async get(key: string): Promise<LlmResponse | null> {
    const entry = this.cache.get(key);
    if (!entry) return null;
    if (Date.now() > entry.expiresAt) {
      this.cache.delete(key);
      return null;
    }
    return structuredClone(entry.response);
  }

  async set(key: string, response: LlmResponse, ttlMs: number): Promise<void> {
    if (this.cache.size >= this.maxSize) {
      this.purgeExpired();
      if (this.cache.size >= this.maxSize) {
        const oldestKey = this.cache.keys().next().value;
        if (oldestKey) this.cache.delete(oldestKey);
      }
    }
    this.cache.set(key, { response: structuredClone(response), expiresAt: Date.now() + ttlMs });
  }

  private purgeExpired(): void {
    const now = Date.now();
    for (const [k, entry] of this.cache.entries()) {
      if (now > entry.expiresAt) {
        this.cache.delete(k);
      }
    }
  }

  async clear(): Promise<void> {
    this.cache.clear();
  }

  async stats(): Promise<{ size: number }> {
    return { size: this.cache.size };
  }
}

export class RedisLlmCache implements LlmCache {
  constructor(
    private readonly prefix: string,
    private readonly redis: IORedis,
  ) {}

  async get(key: string): Promise<LlmResponse | null> {
    const raw = await this.redis.get(`${this.prefix}:${key}`);
    if (!raw) return null;
    try {
      const parsed: unknown = JSON.parse(raw);
      if (!isLlmResponse(parsed)) return null;
      return parsed;
    } catch {
      return null;
    }
  }

  async set(key: string, response: LlmResponse, ttlMs: number): Promise<void> {
    await this.redis.set(`${this.prefix}:${key}`, JSON.stringify(response), "PX", ttlMs);
  }

  async clear(): Promise<void> {
    const pattern = `${this.prefix}:*`;
    let cursor = "0";
    do {
      const [next, keys] = await this.redis.scan(cursor, "MATCH", pattern, "COUNT", 100);
      if (keys.length > 0) {
        await this.redis.del(...keys);
      }
      cursor = next;
    } while (cursor !== "0");
  }

  async stats(): Promise<{ size: number }> {
    const pattern = `${this.prefix}:*`;
    let cursor = "0";
    let size = 0;
    do {
      const [next, keys] = await this.redis.scan(cursor, "MATCH", pattern, "COUNT", 100);
      size += keys.length;
      cursor = next;
    } while (cursor !== "0");
    return { size };
  }
}
