import type { RegistryListResponse, RegistryServer } from "../types.js";
import { HttpRegistrySource, labelFor, type RegistrySource, type SearchOptions } from "./http-source.js";

/**
 * The MCP Rating API (`…/api/v1`): search with quality, safety and start-test
 * data, and servers by slug. The partner key, when set, goes to this registry
 * only.
 */
export class McpRatingSource extends HttpRegistrySource implements RegistrySource {
  readonly kind = "mcprating" as const;
  readonly label: string;

  constructor(
    private readonly baseUrl: string,
    cacheTtlMs = 300_000,
    partnerKey?: string,
  ) {
    super(cacheTtlMs, partnerKey ? { "x-partner-key": partnerKey } : {});
    this.label = labelFor(baseUrl);
  }

  async search(query: string, options?: SearchOptions): Promise<RegistryListResponse> {
    const params = new URLSearchParams({
      search: query,
      limit: String(options?.limit ?? 10),
      offset: String(options?.offset ?? 0),
    });
    if (options?.category) params.set("category", options.category);
    const data = await this.getJson<RegistryListResponse>(`${this.baseUrl}/servers?${params}`, "MCP Rating API");
    const result = data ?? { data: [], total: 0, limit: options?.limit ?? 10, offset: options?.offset ?? 0 };
    for (const s of result.data) s.source = this.label;
    return result;
  }

  async getServer(slug: string): Promise<RegistryServer | null> {
    const server = await this.getJson<RegistryServer>(
      `${this.baseUrl}/servers/${encodeURIComponent(slug)}`,
      "MCP Rating API",
    );
    if (server) server.source = this.label;
    return server;
  }

  /**
   * An official registry name, through MCP Rating's own v0.1 feed, which says
   * which of our rows it is (`_meta["io.mcprating/custom"].slug`). Read from
   * this host only: another registry could put any numbers under that key.
   */
  async getByName(name: string): Promise<RegistryServer | null> {
    const origin = this.baseUrl.replace(/\/api\/v1\/?$/, "");
    const entry = await this.getJson<{ _meta?: Record<string, { slug?: unknown } | undefined> }>(
      `${origin}/v0.1/servers/${encodeURIComponent(name)}/versions/latest`,
      "MCP Rating feed",
    );
    const slug = entry?._meta?.["io.mcprating/custom"]?.slug;
    return typeof slug === "string" ? this.getServer(slug) : null;
  }
}
