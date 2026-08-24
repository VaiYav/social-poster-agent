/**
 * Sprint O: Proxy Rotation Service — residential proxy pool for anti-ban.
 *
 * Env-gated: only active when PROXY_ROTATION_ENABLED=true.
 * Rotates proxies per browser context launch to distribute IP footprint.
 *
 * Supports:
 * - Static proxy list (PROXY_LIST env var, comma-separated)
 * - Rotating proxy gateway (PROXY_GATEWAY_URL env var — single endpoint that rotates IPs server-side)
 * - Per-network sticky sessions (same IP for N minutes per network)
 */
import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { parseBool } from "../config/parse-bool.js";

export interface ProxyConfig {
  server: string;
  username?: string;
  password?: string;
}

@Injectable()
export class ProxyRotationService {
  private readonly logger = new Logger(ProxyRotationService.name);
  private readonly enabled: boolean;
  private readonly proxies: ProxyConfig[] = [];
  private readonly gatewayUrl: string | null;
  private readonly stickyMinutes: number;
  private rotationIndex = 0;
  private stickySessions = new Map<string, { proxy: ProxyConfig; assignedAt: number }>();

  constructor(private readonly configService: ConfigService) {
    this.enabled = parseBool(this.configService.get<string>("PROXY_ROTATION_ENABLED", "false"));
    this.gatewayUrl = this.configService.get<string>("PROXY_GATEWAY_URL", "") || null;
    this.stickyMinutes = this.configService.get<number>("PROXY_STICKY_MINUTES", 10);

    // Parse static proxy list: "http://user:pass@host:port,http://user:pass@host:port"
    const proxyList = this.configService.get<string>("PROXY_LIST", "");
    if (proxyList) {
      for (const entry of proxyList
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)) {
        this.proxies.push(this.parseProxyUrl(entry));
      }
    }

    if (this.enabled) {
      if (this.gatewayUrl) {
        this.logger.log(`Proxy rotation enabled — gateway mode: ${this.gatewayUrl}`);
      } else if (this.proxies.length > 0) {
        this.logger.log(`Proxy rotation enabled — static pool: ${this.proxies.length} proxies`);
      } else {
        this.logger.warn(
          "Proxy rotation enabled but no proxies configured (PROXY_LIST or PROXY_GATEWAY_URL)",
        );
      }
    }
  }

  /**
   * Get a proxy for a given network. Uses sticky sessions so the same network
   * gets the same proxy for `stickyMinutes` minutes.
   */
  getProxy(network: string): ProxyConfig | null {
    if (!this.enabled) return null;

    // Gateway mode — single endpoint, server rotates IPs
    if (this.gatewayUrl) {
      return { server: this.gatewayUrl };
    }

    if (this.proxies.length === 0) return null;

    // Check sticky session
    const sticky = this.stickySessions.get(network);
    const now = Date.now();
    const stickyMs = this.stickyMinutes * 60 * 1000;

    if (sticky && now - sticky.assignedAt < stickyMs) {
      return sticky.proxy;
    }

    // Rotate to next proxy
    const proxy = this.proxies[this.rotationIndex % this.proxies.length]!;
    this.rotationIndex++;

    this.stickySessions.set(network, { proxy, assignedAt: now });
    this.logger.debug(`Assigned proxy to ${network}: ${proxy.server}`);
    return proxy;
  }

  /**
   * Clear sticky session for a network (e.g., on ban or session reset).
   */
  clearStickySession(network: string): void {
    this.stickySessions.delete(network);
    this.logger.debug(`Cleared sticky proxy session for ${network}`);
  }

  /**
   * Get the list of all configured proxies (for health checks / status).
   */
  getProxyPool(): ProxyConfig[] {
    return [...this.proxies];
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  private parseProxyUrl(url: string): ProxyConfig {
    try {
      const parsed = new URL(url);
      const config: ProxyConfig = {
        server: `${parsed.protocol}//${parsed.hostname}:${parsed.port}`,
      };
      if (parsed.username) {
        config.username = decodeURIComponent(parsed.username);
      }
      if (parsed.password) {
        config.password = decodeURIComponent(parsed.password);
      }
      return config;
    } catch {
      // If URL parsing fails, treat as raw server address
      return { server: url };
    }
  }
}
