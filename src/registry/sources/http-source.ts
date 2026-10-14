import { log } from "../../utils/logger.js";
import { USER_AGENT } from "../../version.js";
import type { RegistryListResponse, RegistryServer } from "../types.js";

export interface RegistryStatus {
  lastSuccessfulCall: Date | null;
  lastError: string | null;
  cacheSize: number;
}

export interface SearchOptions {
  category?: string;
  limit?: number;
  offset?: number;
}

/**
 * One registry the gateway reads: the MCP Rating API, or any registry that
 * speaks the official MCP Registry API (v0.1). RegistryClient fans out over
 * these; nothing else in the gateway knows which kind it is talking to.
 */
export interface RegistrySource {
  /** Shown to the user: the registry's host, e.g. "registry.modelcontextprotocol.io". */
  readonly label: string;
  readonly kind: "mcprating" | "mcp-registry";
  search(query: string, options?: SearchOptions): Promise<RegistryListResponse>;
  /** By this source's own slug. Null when it has no such server, or keys servers by name only. */
  getServer(slug: string): Promise<RegistryServer | null>;
  /** By official registry name, `io.github.owner/server`. */
  getByName(name: string): Promise<RegistryServer | null>;
  getStatus(): RegistryStatus;
  clearCache(): void;
}

interface CacheEntry<T> {
  data: T;
  expiresAt: number;
}

/**
 * Cache, retry and reachability for an HTTP registry. Sends the gateway's
 * User-Agent and the headers the subclass gives it — nothing else.
 */
export abstract class HttpRegistrySource {
  private cache = new Map<string, CacheEntry<unknown>>();
  private lastSuccessfulCall: Date | null = null;
  private lastError: string | null = null;

  constructor(
    protected readonly cacheTtlMs: number,
    /** Extra request headers. Only for this registry: never a key meant for another. */
    private readonly extraHeaders: Record<string, string> = {},
    /** Per request. RegistryClient's search deadline is separate: a late answer still fills the cache. */
    private readonly timeoutMs = 10_000,
  ) {}

  getStatus(): RegistryStatus {
    return { lastSuccessfulCall: this.lastSuccessfulCall, lastError: this.lastError, cacheSize: this.cache.size };
  }

  clearCache(): void {
    this.cache.clear();
    log.debug("Registry cache cleared");
  }

  /**
   * GET a JSON document, cached. `null` for a 404 (also cached); throws on any
   * other failure, after recording it for mcp_gateway_health.
   */
  protected async getJson<T>(url: string, describe: string): Promise<T | null> {
    const key = `json:${url}`;
    const hit = this.cache.get(key) as CacheEntry<T | null> | undefined;
    if (hit && Date.now() <= hit.expiresAt) {
      log.debug("Registry cache hit", { url });
      return hit.data;
    }
    try {
      const res = await this.fetchWithRetry(url);
      if (res.status === 404) {
        this.setCache(key, null);
        this.recordSuccess();
        return null;
      }
      if (!res.ok) throw new Error(`${describe} returned ${res.status}: ${res.statusText}`);
      const data = (await res.json()) as T;
      this.setCache(key, data);
      this.recordSuccess();
      return data;
    } catch (err) {
      this.recordError(err);
      throw err;
    }
  }

  private setCache<T>(key: string, data: T): void {
    this.cache.set(key, { data, expiresAt: Date.now() + this.cacheTtlMs });
  }

  private async fetchWithRetry(url: string, maxRetries = 2): Promise<Response> {
    const headers: Record<string, string> = { "User-Agent": USER_AGENT, ...this.extraHeaders };
    let lastError: unknown;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        const res = await fetch(url, { headers, signal: AbortSignal.timeout(this.timeoutMs) });
        // Don't retry on client errors (4xx) or success
        if (res.ok || res.status < 500) return res;
        lastError = new Error(`HTTP ${res.status}: ${res.statusText}`);
        log.warn("Registry returned 5xx, retrying", { url, status: res.status, attempt: attempt + 1, maxRetries });
      } catch (err) {
        // A registry too slow to answer won't be faster on the second try, and
        // three timeouts in a row held mcp_discover for half a minute.
        if ((err as Error)?.name === "TimeoutError") {
          throw new Error(`no answer within ${this.timeoutMs / 1000}s`);
        }
        lastError = err;
        if (attempt < maxRetries) {
          log.warn("Registry fetch failed, retrying", { url, error: String(err), attempt: attempt + 1, maxRetries });
        }
      }
      if (attempt < maxRetries) await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
    }
    throw lastError;
  }

  private recordSuccess(): void {
    this.lastSuccessfulCall = new Date();
    this.lastError = null;
  }

  private recordError(err: unknown): void {
    this.lastError = err instanceof Error ? err.message : String(err);
  }
}

/** The host a registry URL names, as the user sees it. */
export function labelFor(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}
