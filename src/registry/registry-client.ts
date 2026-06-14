import { log } from "../utils/logger.js";
import { RegistryError } from "../utils/errors.js";
import type {
  RegistryServer,
  RegistryListResponse,
  InstallCommand,
  TrustTier,
} from "./types.js";

interface CacheEntry<T> {
  data: T;
  expiresAt: number;
}

export interface RegistryStatus {
  lastSuccessfulCall: Date | null;
  lastError: string | null;
  cacheSize: number;
}

/**
 * HTTP client for querying the MCP-Rating API.
 *
 * Uses native fetch (Node 18+). Falls back gracefully when the
 * registry is unreachable — users can still connect servers manually
 * via explicit command+args.
 *
 * Features:
 * - In-memory cache with configurable TTL
 * - Automatic retry with backoff for transient failures (5xx / network)
 * - Reachability tracking for health diagnostics
 */
export class RegistryClient {
  private cache = new Map<string, CacheEntry<unknown>>();
  private _lastSuccessfulCall: Date | null = null;
  private _lastError: string | null = null;

  constructor(
    private readonly baseUrl: string,
    private readonly cacheTtlMs: number = 300_000,
    private readonly partnerKey?: string,
  ) {}

  async search(
    query: string,
    options?: { category?: string; limit?: number; offset?: number },
  ): Promise<RegistryListResponse> {
    const params = new URLSearchParams({
      search: query,
      limit: String(options?.limit ?? 10),
      offset: String(options?.offset ?? 0),
    });
    if (options?.category) {
      params.set("category", options.category);
    }

    const url = `${this.baseUrl}/servers?${params}`;
    const cacheKey = `search:${url}`;

    const cached = this.getFromCache<RegistryListResponse>(cacheKey);
    if (cached) {
      log.debug("Registry cache hit", { cacheKey });
      return cached;
    }

    log.debug("Registry search", { url });

    try {
      const res = await this.fetchWithRetry(url);
      if (!res.ok) {
        throw new RegistryError(
          `Registry API returned ${res.status}: ${res.statusText}`,
        );
      }
      const data = (await res.json()) as RegistryListResponse;
      this.setCache(cacheKey, data);
      this.recordSuccess();
      return data;
    } catch (err) {
      this.recordError(err);
      if (err instanceof RegistryError) throw err;
      throw new RegistryError(
        `Failed to reach MCP-Rating registry at ${this.baseUrl}: ${String(err)}`,
      );
    }
  }

  async getServer(slug: string): Promise<RegistryServer | null> {
    const url = `${this.baseUrl}/servers/${encodeURIComponent(slug)}`;
    const cacheKey = `server:${slug}`;

    const cached = this.getFromCache<RegistryServer | null>(cacheKey);
    if (cached !== undefined) {
      log.debug("Registry cache hit", { cacheKey });
      return cached;
    }

    log.debug("Registry getServer", { url });

    try {
      const res = await this.fetchWithRetry(url);
      if (res.status === 404) {
        this.setCache(cacheKey, null);
        this.recordSuccess();
        return null;
      }
      if (!res.ok) {
        throw new RegistryError(
          `Registry API returned ${res.status}: ${res.statusText}`,
        );
      }
      const data = (await res.json()) as RegistryServer;
      this.setCache(cacheKey, data);
      this.recordSuccess();
      return data;
    } catch (err) {
      this.recordError(err);
      if (err instanceof RegistryError) throw err;
      throw new RegistryError(
        `Failed to reach MCP-Rating registry: ${String(err)}`,
      );
    }
  }

  /**
   * Resolve install command for a server.
   * Prefers the stored `installCommand`, falling back to `npx -y {npmPackage}`.
   */
  resolveInstallCommand(server: RegistryServer): InstallCommand | null {
    if (server.installCommand) {
      const parts = server.installCommand.split(/\s+/);
      if (parts.length > 0) {
        return { command: parts[0], args: parts.slice(1) };
      }
    }
    if (server.npmPackage) {
      return { command: "npx", args: ["-y", server.npmPackage] };
    }
    return null;
  }

  /**
   * Determine trust tier from registry data.
   *
   * NOTE: This logic is mirrored in the main app at src/scoring/trust-tier.ts
   * (so the REST API exposes the same `trustTier`). Keep the two in sync — the
   * gateway is a separately-published package and can't import from the root.
   */
  static determineTrustTier(server: RegistryServer): TrustTier {
    if (
      server.isVerified ||
      (server.isOfficial && (server.qualityScore ?? 0) >= 80)
    ) {
      return "verified";
    }
    if (
      (server.qualityScore ?? 0) >= 60 &&
      server.repositoryUrl &&
      server.installCommand
    ) {
      return "trusted";
    }
    if ((server.qualityScore ?? 0) >= 30) {
      return "community";
    }
    return "unknown";
  }

  /** Get reachability status for diagnostics. */
  getStatus(): RegistryStatus {
    return {
      lastSuccessfulCall: this._lastSuccessfulCall,
      lastError: this._lastError,
      cacheSize: this.cache.size,
    };
  }

  /** Clear all cached entries. */
  clearCache(): void {
    this.cache.clear();
    log.debug("Registry cache cleared");
  }

  // ── Cache helpers ──────────────────────────────────────────────

  private getFromCache<T>(key: string): T | undefined {
    const entry = this.cache.get(key) as CacheEntry<T> | undefined;
    if (!entry) return undefined;
    if (Date.now() > entry.expiresAt) {
      this.cache.delete(key);
      return undefined;
    }
    return entry.data;
  }

  private setCache<T>(key: string, data: T): void {
    this.cache.set(key, {
      data,
      expiresAt: Date.now() + this.cacheTtlMs,
    });
  }

  // ── Retry helper ───────────────────────────────────────────────

  private async fetchWithRetry(url: string, maxRetries = 2): Promise<Response> {
    const headers: Record<string, string> = {};
    if (this.partnerKey) {
      headers["x-partner-key"] = this.partnerKey;
    }

    let lastError: unknown;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        const res = await fetch(url, {
          headers,
          signal: AbortSignal.timeout(10_000),
        });
        // Don't retry on client errors (4xx) or success
        if (res.ok || res.status < 500) return res;
        // 5xx — retry if attempts remain
        lastError = new Error(`HTTP ${res.status}: ${res.statusText}`);
        log.warn("Registry returned 5xx, retrying", {
          url,
          status: res.status,
          attempt: attempt + 1,
          maxRetries,
        });
      } catch (err) {
        lastError = err;
        if (attempt < maxRetries) {
          log.warn("Registry fetch failed, retrying", {
            url,
            error: String(err),
            attempt: attempt + 1,
            maxRetries,
          });
        }
      }
      if (attempt < maxRetries) {
        await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
      }
    }
    throw lastError;
  }

  // ── Reachability tracking ──────────────────────────────────────

  private recordSuccess(): void {
    this._lastSuccessfulCall = new Date();
    this._lastError = null;
  }

  private recordError(err: unknown): void {
    this._lastError = err instanceof Error ? err.message : String(err);
  }
}
