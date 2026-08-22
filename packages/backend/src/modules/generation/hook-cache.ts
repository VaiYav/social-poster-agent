import { createHash } from "node:crypto";

export interface HookCacheEntry {
  hooks: string[];
  model: string;
  expiresAt: number;
}

export interface HookCacheStats {
  size: number;
  maxSize: number;
  ttlMs: number;
}

export interface IHookCache {
  get(key: string): HookCacheEntry | null;
  set(key: string, hooks: string[], model: string): void;
  clear(): void;
  getStats(): HookCacheStats;
}

/**
 * In-memory hook cache with TTL and max-size eviction.
 *
 * Keys are SHA256 hashes of the topic + sorted keywords + sorted facts.
 * Entries expire after `ttlMs`; on access, expired entries are removed.
 * When full, the oldest entry (by insertion order) is evicted.
 */
export class InMemoryHookCache implements IHookCache {
  private readonly store = new Map<string, HookCacheEntry>();

  constructor(
    private readonly maxSize = 50,
    private readonly ttlMs = 30 * 60 * 1000,
  ) {}

  get(key: string): HookCacheEntry | null {
    const entry = this.store.get(key);
    if (!entry) return null;
    if (Date.now() > entry.expiresAt) {
      this.store.delete(key);
      return null;
    }
    return entry;
  }

  set(key: string, hooks: string[], model: string): void {
    // Evict expired entries first so size accounting stays honest.
    this.evictExpired();

    if (this.store.size >= this.maxSize) {
      const oldestKey = this.store.keys().next().value;
      if (oldestKey) this.store.delete(oldestKey);
    }

    this.store.set(key, { hooks, model, expiresAt: Date.now() + this.ttlMs });
  }

  clear(): void {
    this.store.clear();
  }

  getStats(): HookCacheStats {
    this.evictExpired();
    return { size: this.store.size, maxSize: this.maxSize, ttlMs: this.ttlMs };
  }

  private evictExpired(): void {
    const now = Date.now();
    for (const [key, entry] of this.store) {
      if (entry.expiresAt < now) {
        this.store.delete(key);
      }
    }
  }
}

const defaultHookCache: IHookCache = new InMemoryHookCache();

/** Active cache used by the graph when no instance is supplied. */
let activeHookCache: IHookCache = defaultHookCache;

export function getActiveHookCache(): IHookCache {
  return activeHookCache;
}

export function setActiveHookCache(cache: IHookCache): void {
  activeHookCache = cache;
}

export function getHookCacheStats(): HookCacheStats {
  return activeHookCache.getStats();
}

export function clearHookCache(): void {
  activeHookCache.clear();
}

/**
 * Compute a cache key for hook generation from the deterministic inputs.
 * Excludes brandVoice (constant per process) and performanceGuidance (advisory).
 */
export function hookCacheKey(topic: string, keywords: string[], facts: string[]): string {
  const input = `${topic}||${keywords.slice().sort().join(",")}||${facts.slice().sort().join("\n")}`;
  return createHash("sha256").update(input).digest("hex").slice(0, 32);
}
