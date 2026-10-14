import type { RegistryListResponse, RegistryServer } from "../types.js";
import { ociLaunchCommand, registryLaunchCommand, type RegistryPackageLike } from "../launch-command.js";
import { HttpRegistrySource, labelFor, type RegistrySource, type SearchOptions } from "./http-source.js";

/** server.json, as far as the gateway reads it (2025-12-11 schema). */
export interface ServerJson {
  name: string;
  title?: string;
  description?: string;
  version?: string;
  websiteUrl?: string;
  repository?: { url?: string };
  packages?: RegistryPackageLike[];
  remotes?: Array<{
    type?: string;
    url?: string;
    headers?: Array<{ name?: string; description?: string; isRequired?: boolean; isSecret?: boolean }>;
  }>;
}

/** One entry of a v0.1 list or version response. */
export interface ServerEntry {
  server: ServerJson;
  _meta?: Record<string, unknown>;
}

/**
 * The slug a registry name gets — the same one MCP Rating gives the official
 * entry (`io.github.Owner/name` → `io-github-owner-name`), and a valid part of a
 * proxied tool name (`slug__tool`).
 */
export function slugForName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
}

/** Status the official registry marks entries with; a deleted one can't be installed. */
function status(entry: ServerEntry): string | undefined {
  const official = entry._meta?.["io.modelcontextprotocol.registry/official"] as { status?: unknown } | undefined;
  return typeof official?.status === "string" ? official.status : undefined;
}

/**
 * A server.json entry as a RegistryServer. Only what the entry itself says:
 * no score and no start test, so its trust tier is "unknown" and connecting
 * asks for confirmation. Anything under `_meta` is the registry's own and is
 * not read — a registry could put any numbers under MCP Rating's key.
 */
export function fromServerJson(entry: ServerEntry, source: string): RegistryServer {
  const s = entry.server;
  const pkgs = s.packages ?? [];
  // The first package we can lay out, preferring npm, then PyPI, then OCI.
  let chosen: RegistryPackageLike | undefined;
  let installCommand: string | null = null;
  for (const type of ["npm", "pypi", "oci"]) {
    for (const p of pkgs.filter((p) => p?.registryType === type)) {
      const cmd = type === "oci" ? ociLaunchCommand(p) : registryLaunchCommand(p);
      if (cmd) {
        chosen = p;
        installCommand = cmd;
        break;
      }
    }
    if (chosen) break;
  }
  const remotes = (s.remotes ?? []).filter((r) => r && typeof r.url === "string");
  const envVars = (chosen?.environmentVariables ?? []).filter((e) => e && typeof e.name === "string");
  const needed = envVars
    .filter((e) => e.isRequired || e.isSecret)
    .map((e) => ({ name: e.name!, ...(e.description ? { description: e.description } : {}) }));
  const remoteHeaders = remotes.flatMap((r) => r.headers ?? []).filter((h) => h?.isRequired || h?.isSecret);
  const accessMethod = chosen
    ? { npm: "npm", pypi: "pypi", oci: "docker" }[chosen.registryType] ?? null
    : remotes.length
      ? "remote"
      : null;

  return {
    id: `${source}:${s.name}`,
    slug: slugForName(s.name),
    name: s.title || s.name,
    description: s.description ?? null,
    author: null,
    repositoryUrl: s.repository?.url ?? null,
    npmPackage: chosen?.registryType === "npm" ? chosen.identifier : null,
    homepage: s.websiteUrl ?? null,
    installCommand,
    stars: null,
    weeklyDownloads: null,
    qualityScore: null,
    isOfficial: false,
    isVerified: false,
    supportsDiscovery: false,
    discoveryUrl: null,
    accessMethod,
    category: null,
    tools: [],
    resources: [],
    metadata: {
      registryName: s.name,
      version: s.version ?? null,
      // Every package it declares, launchable or not: what MCP Rating is asked about.
      packages: pkgs
        .filter((p) => p && typeof p.identifier === "string")
        .map((p) => ({ registryType: p.registryType, identifier: p.identifier })),
      remotes,
      authEnvVars: needed,
      requiresAuth: needed.length > 0 || remoteHeaders.length > 0,
    },
    requiresAuth: needed.length > 0 || remoteHeaders.length > 0,
    authDetails: {
      envVars: needed,
      allEnvVars: envVars.map((e) => ({ name: e.name!, ...(e.description ? { description: e.description } : {}) })),
      schemes: [],
    },
    verification: null,
    registryName: s.name,
    ref: s.name,
    source,
  };
}

/**
 * A registry that speaks the official MCP Registry API, v0.1: the official
 * registry, a company's own, or MCP Rating's feed.
 *
 * Its search is a substring of the server NAME, so "web search" would match
 * nothing. We ask for the query's longest word and rank what comes back by how
 * many of the query's words appear in name, title or description.
 */
export class McpRegistrySource extends HttpRegistrySource implements RegistrySource {
  readonly kind = "mcp-registry" as const;
  readonly label: string;
  private readonly baseUrl: string;
  /** slug → registry name, for every entry this source has returned. */
  private readonly names = new Map<string, string>();

  constructor(url: string, cacheTtlMs = 300_000) {
    // The official registry's search took 7–40 s on 2026-10-14. A generous
    // per-request timeout lets a late answer reach the cache, while
    // RegistryClient's deadline keeps mcp_discover from waiting for it.
    super(cacheTtlMs, {}, 30_000);
    this.baseUrl = url.replace(/\/+$/, "").replace(/\/v0(\.1)?$/, "");
    this.label = labelFor(this.baseUrl);
  }

  async search(query: string, options?: SearchOptions): Promise<RegistryListResponse> {
    const limit = options?.limit ?? 10;
    const words = [...new Set(query.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length >= 2))];
    const term = [...words].sort((a, b) => b.length - a.length)[0] ?? query.trim();
    const params = new URLSearchParams({ search: term, limit: "100", version: "latest" });
    const page = await this.getJson<{ servers?: ServerEntry[] }>(`${this.baseUrl}/v0.1/servers?${params}`, this.label);

    const scored = (page?.servers ?? [])
      .filter((e) => e?.server?.name && status(e) !== "deleted")
      .map((e, i) => {
        const text = `${e.server.name} ${e.server.title ?? ""} ${e.server.description ?? ""}`.toLowerCase();
        return { e, i, hits: words.filter((w) => text.includes(w)).length };
      })
      .sort((a, b) => b.hits - a.hits || a.i - b.i);
    const data = scored.slice(0, limit).map(({ e }) => this.remember(fromServerJson(e, this.label)));
    return { data, total: scored.length, limit, offset: 0 };
  }

  async getServer(slug: string): Promise<RegistryServer | null> {
    const name = this.names.get(slug);
    return name ? this.getByName(name) : null;
  }

  async getByName(name: string): Promise<RegistryServer | null> {
    const entry = await this.getJson<ServerEntry>(
      `${this.baseUrl}/v0.1/servers/${encodeURIComponent(name)}/versions/latest`,
      this.label,
    );
    if (!entry?.server?.name || status(entry) === "deleted") return null;
    return this.remember(fromServerJson(entry, this.label));
  }

  private remember(server: RegistryServer): RegistryServer {
    this.names.set(server.slug, server.registryName!);
    return server;
  }
}
