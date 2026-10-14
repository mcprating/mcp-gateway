import { log } from "../utils/logger.js";
import { RegistryError } from "../utils/errors.js";
import { isCommandAvailable } from "../connection/auto-installer.js";
import type { GatewayConfig, RegistryConfig } from "../config/types.js";
import type {
  RegistryServer,
  RegistryListResponse,
  InstallCommand,
  TrustTier,
} from "./types.js";
import type { RegistrySource, RegistryStatus, SearchOptions } from "./sources/http-source.js";
import { McpRatingSource, type LookupRecord } from "./sources/mcprating-source.js";
import { lookupKeys } from "./package-keys.js";
import { launchKeys } from "./launch-keys.js";
import { maintenanceFacts, type TrustFacts } from "./trust-facts.js";
import { McpRegistrySource } from "./sources/mcp-registry-source.js";

export type { RegistryStatus } from "./sources/http-source.js";

/**
 * PATH lookup, memoised per launcher for a minute. mcp_discover checks every
 * result, and a `which`/`where` process per result would add up; a minute is
 * short enough that installing uv mid-session is noticed.
 */
const commandCache = new Map<string, { ok: boolean; at: number }>();
function hasCommandCached(command: string): boolean {
  const hit = commandCache.get(command);
  if (hit && Date.now() - hit.at < 60_000) return hit.ok;
  const ok = isCommandAvailable(command);
  commandCache.set(command, { ok, at: Date.now() });
  return ok;
}

/** A hosted server's endpoint, as the registry lists it in `metadata.remotes`. */
export interface RemoteEndpoint {
  url: string;
  transportType: "sse" | "streamable-http";
  /** Headers the endpoint says it needs — the gateway cannot send these yet. */
  requiredHeaders: string[];
}

/**
 * Whether the gateway can start a server right now, from registry data, this
 * machine and the registry's own verification run:
 *   - "ready"          — installable or keyless-hosted, launcher present, any
 *                        declared keys set, and not seen failing in our test
 *   - "needs-setup"    — a declared key is missing here, the launcher (uvx,
 *                        docker…) isn't installed, the hosted endpoint needs a
 *                        header the gateway can't send, or our test found it
 *                        needs credentials
 *   - "failed-in-test" — runnable on paper, but didn't start when the registry
 *                        tried it (no credentials given)
 *   - "not-runnable"   — no install command and no usable endpoint
 */
export interface Readiness {
  level: "ready" | "needs-setup" | "failed-in-test" | "not-runnable";
  via: "install" | "remote" | null;
  /** Env var, header or launcher names that are missing. */
  missing: string[];
  remote: RemoteEndpoint | null;
  /** True when the registry's latest attempt started it and listed its tools. */
  verified: boolean;
}


/**
 * Every name a row stands for, so one server found in two registries is listed
 * once: its official registry names (MCP Rating lists an official entry under
 * its npm row and keeps the names in metadata.group.registryNames) and its npm
 * package.
 */
function identities(s: RegistryServer): string[] {
  const names = [
    s.registryName,
    s.metadata?.registryName,
    ...(((s.metadata?.group as { registryNames?: unknown } | undefined)?.registryNames as unknown[]) ?? []),
  ].filter((n): n is string => typeof n === "string" && n.length > 0);
  const keys = names.map((n) => `name:${n.toLowerCase()}`);
  if (s.npmPackage) keys.push(`npm:${s.npmPackage.toLowerCase()}`);
  return keys.length > 0 ? keys : [`row:${s.source ?? ""}#${s.slug}`];
}

/**
 * The registries the gateway reads, as one: MCP Rating by default, or any list
 * of registries that speak the MCP Rating API or the official MCP Registry API
 * (MCP_GATEWAY_REGISTRIES). Searches go to all of them and are merged, the
 * first-listed registry's copy of a server winning; lookups try them in order.
 *
 * Falls back gracefully when a registry is unreachable — the others still
 * answer, and users can always connect servers manually via command + args.
 */
export class RegistryClient {
  private readonly sources: RegistrySource[];
  /**
   * How long a search waits for the registries. One that hasn't answered by
   * then is reported as unreachable for this search; its answer still lands in
   * its cache, so the same search again is quick.
   */
  searchDeadlineMs = 15_000;
  /** How long MCP Rating gets to rate other registries' servers before they're shown unrated. */
  ratingDeadlineMs = 5_000;

  /** A list of sources, or (as before) one MCP Rating API URL. */
  constructor(sources: RegistrySource[] | string, cacheTtlMs = 300_000, partnerKey?: string) {
    this.sources = typeof sources === "string" ? [new McpRatingSource(sources, cacheTtlMs, partnerKey)] : sources;
    if (this.sources.length === 0) throw new Error("RegistryClient needs at least one registry");
  }

  static fromConfig(
    config: Pick<GatewayConfig, "registryApiUrl" | "registries" | "registryCacheTtlMs" | "partnerKey">,
  ): RegistryClient {
    const list: RegistryConfig[] = config.registries?.length
      ? config.registries
      : [{ type: "mcprating", url: config.registryApiUrl }];
    return new RegistryClient(
      list.map((r) =>
        r.type === "mcprating"
          ? new McpRatingSource(r.url, config.registryCacheTtlMs, config.partnerKey)
          : new McpRegistrySource(r.url, config.registryCacheTtlMs),
      ),
    );
  }

  /** The configured registries, in order. */
  get registries(): Array<{ label: string; kind: RegistrySource["kind"] }> {
    return this.sources.map((s) => ({ label: s.label, kind: s.kind }));
  }

  /**
   * Search every registry and merge: each registry's results in its own order,
   * taken in turns so a second registry isn't buried behind the first's whole
   * list, and a server already listed by an earlier registry skipped. Fails
   * only when no registry answers; `unreachable` names the ones that didn't.
   */
  async search(query: string, options?: SearchOptions): Promise<RegistryListResponse> {
    const settled = await Promise.allSettled(
      this.sources.map((s) => withDeadline(s.search(query, options), this.searchDeadlineMs)),
    );
    const answered = settled.flatMap((r, i) => (r.status === "fulfilled" ? [r.value] : []));
    const unreachable = settled.flatMap((r, i) => {
      if (r.status === "fulfilled") return [];
      log.warn("Registry search failed", { registry: this.sources[i].label, error: String(r.reason) });
      return [this.sources[i].label];
    });
    if (answered.length === 0) {
      const why = settled.map((r, i) => `${this.sources[i].label}: ${reason(r)}`).join("; ");
      throw new RegistryError(`No registry answered (${why})`);
    }

    const seen = new Set<string>();
    const data: RegistryServer[] = [];
    const longest = Math.max(...answered.map((r) => r.data.length));
    for (let i = 0; i < longest; i++) {
      for (const result of answered) {
        const s = result.data[i];
        if (!s) continue;
        const keys = identities(s);
        if (keys.some((k) => seen.has(k))) continue;
        for (const k of keys) seen.add(k);
        data.push(s);
      }
    }
    await this.rate(data);
    return {
      data,
      total: answered.reduce((n, r) => n + (r.total ?? r.data.length), 0),
      limit: options?.limit ?? 10,
      offset: options?.offset ?? 0,
      ...(unreachable.length ? { unreachable } : {}),
    };
  }

  /**
   * A server by slug, or by official registry name (`io.github.owner/server`),
   * from the first registry that has it. Null when none does; throws only when
   * none could be asked.
   */
  async getServer(ref: string): Promise<RegistryServer | null> {
    const byName = ref.includes("/");
    let lastError: unknown;
    let answered = false;
    for (const s of this.sources) {
      try {
        const hit = byName ? await s.getByName(ref) : await s.getServer(ref);
        answered = true;
        if (hit) {
          if (s.kind !== "mcprating") await this.rate([hit]);
          return hit;
        }
      } catch (err) {
        lastError = err;
        log.warn("Registry lookup failed", { registry: s.label, ref, error: String(err) });
      }
    }
    if (!answered) {
      throw new RegistryError(`No registry answered for "${ref}": ${String((lastError as Error)?.message ?? lastError)}`);
    }
    return null;
  }

  /**
   * Give servers from other registries MCP Rating's record of the same
   * package — score, safety flags, start test — in one request for the page.
   * Only when MCP Rating is one of the configured registries: nothing is sent
   * to it otherwise.
   *
   * By package, never by name: any registry can give any package a well-known
   * name, and a name match would hand that package someone else's score. The
   * name is used the other way round — when MCP Rating knows the name as a
   * different package, the row says so. A package MCP Rating has delisted
   * stays unrated, with the reason.
   *
   * Best effort: if MCP Rating is slow or down, the rows stay unrated.
   */
  async rate(rows: RegistryServer[]): Promise<void> {
    const rater = this.sources.find((s): s is McpRatingSource => s instanceof McpRatingSource);
    if (!rater) return;
    const unrated = rows
      .filter((r) => r.source !== rater.label && (r.qualityScore === null || r.qualityScore === undefined))
      .slice(0, 12)
      .map((r) => ({ r, k: lookupKeys(r) }));
    if (unrated.length === 0) return;
    // Package keys first — they decide scores; names only flag a mismatch.
    const keys = [
      ...new Set([...unrated.flatMap(({ k }) => k.packages), ...unrated.flatMap(({ k }) => (k.name ? [k.name] : []))]),
    ].slice(0, 25);
    if (keys.length === 0) return;

    let records: Map<string, LookupRecord | null>;
    try {
      records = await withDeadline(rater.lookup(keys), this.ratingDeadlineMs);
    } catch (err) {
      log.warn("MCP Rating lookup failed; servers from other registries stay unrated", { error: String(err) });
      return;
    }

    for (const { r, k } of unrated) {
      const rec = k.packages.map((key) => records.get(key)).find((x): x is LookupRecord => !!x);
      if (rec) {
        r.rating = { by: rater.label, slug: rec.slug, url: rec.url };
        if (rec.delistedReason) {
          r.delistedReason = rec.delistedReason;
        } else {
          r.qualityScore = rec.qualityScore;
          r.safetyScore = rec.safetyScore;
          r.safetyFlags = rec.safetyFlags;
          r.isOfficial = rec.isOfficial;
          r.isVerified = rec.isVerified;
          r.verification = rec.verification;
          r.stars = rec.stars;
          r.weeklyDownloads = rec.weeklyDownloads;
          if (rec.maintenance) r.maintenance = rec.maintenance;
        }
      }
      const named = k.name ? records.get(k.name) : null;
      if (named && k.packages.length > 0 && !k.packages.some((p) => named.keys.includes(p))) {
        const theirs = named.keys.filter((x) => !x.startsWith("name:")).join(", ") || "a different package";
        r.trustWarning =
          `MCP Rating knows ${r.registryName} as ${theirs}; this registry's entry of that name runs ${k.packages.join(", ")}.`;
      }
    }
  }

  /** The MCP Rating registry, if one is configured: the only source of scores. */
  private get rater(): McpRatingSource | undefined {
    return this.sources.find((s): s is McpRatingSource => s instanceof McpRatingSource);
  }

  /** Whether scores can be had at all: MCP Rating is one of the registries. */
  get ratesPackages(): boolean {
    return !!this.rater;
  }

  /** What MCP Rating knows about a server a registry returned (rated by rate() if it came from elsewhere). */
  factsFor(server: RegistryServer): TrustFacts {
    const rater = this.rater;
    const ours = !!rater && server.source === rater.label;
    const by = ours ? rater.label : server.rating?.by ?? null;
    return {
      by,
      consulted: !!rater,
      url: ours ? `${rater.siteUrl}/servers/${encodeURIComponent(server.slug)}` : server.rating?.url ?? null,
      qualityScore: server.qualityScore ?? null,
      tier: RegistryClient.determineTrustTier(server),
      safetyScore: server.safetyScore ?? null,
      safetyFlags: server.safetyFlags ?? [],
      verification: server.verification ?? null,
      maintenance: server.maintenance ?? (ours ? maintenanceFacts(server) : null),
      delistedReason: server.delistedReason ?? null,
      trustWarning: server.trustWarning ?? null,
    };
  }

  /**
   * What MCP Rating knows about the package an explicit launch would run
   * (`npx pkg`, `uvx pkg`, `docker run image`, a URL) — so a known package
   * started by command is judged as itself, not as "unknown". Best effort.
   */
  async factsForLaunch(launch: { command?: string; args?: string[]; url?: string }): Promise<TrustFacts> {
    const rater = this.rater;
    const none: TrustFacts = {
      by: null, consulted: !!rater, url: null, qualityScore: null, tier: "unknown", safetyScore: null,
      safetyFlags: [], verification: null, maintenance: null, delistedReason: null, trustWarning: null,
    };
    const keys = launchKeys(launch);
    if (!rater || keys.length === 0) return none;
    let records: Map<string, LookupRecord | null>;
    try {
      records = await withDeadline(rater.lookup(keys), this.ratingDeadlineMs);
    } catch (err) {
      log.warn("MCP Rating lookup failed; the launch stays unrated", { error: String(err) });
      return none;
    }
    const rec = keys.map((k) => records.get(k)).find((x): x is LookupRecord => !!x);
    if (!rec) return none;
    const delisted = !!rec.delistedReason;
    return {
      by: rater.label,
      consulted: true,
      url: rec.url,
      qualityScore: delisted ? null : rec.qualityScore,
      tier: delisted ? "unknown" : rec.trustTier ?? "unknown",
      safetyScore: rec.safetyScore,
      safetyFlags: rec.safetyFlags,
      verification: rec.verification,
      maintenance: rec.maintenance ?? null,
      delistedReason: rec.delistedReason,
      trustWarning: null,
    };
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
   * The first http(s) endpoint in `metadata.remotes`. Anything else — a
   * `javascript:` or `file:` URL in registry data somebody else wrote — is
   * skipped, as the website's remoteLaunch does.
   */
  resolveRemote(server: RegistryServer): RemoteEndpoint | null {
    const remotes = (server.metadata as { remotes?: unknown } | null | undefined)?.remotes;
    if (!Array.isArray(remotes)) return null;
    for (const r of remotes as Array<{ url?: unknown; type?: unknown; headers?: unknown } | null>) {
      if (!r || typeof r.url !== "string") continue;
      let parsed: URL;
      try {
        parsed = new URL(r.url);
      } catch {
        continue;
      }
      if (parsed.protocol !== "https:" && parsed.protocol !== "http:") continue;
      const headers = Array.isArray(r.headers)
        ? (r.headers as Array<{ name?: unknown; isRequired?: unknown; isSecret?: unknown } | null>)
        : [];
      const requiredHeaders = headers
        .filter((h) => h && typeof h.name === "string" && (h.isRequired === true || h.isSecret === true))
        .map((h) => String(h!.name));
      return {
        url: parsed.href,
        transportType: r.type === "sse" ? "sse" : "streamable-http",
        requiredHeaders,
      };
    }
    return null;
  }

  /**
   * See {@link Readiness}. `env` defaults to this process's environment, and
   * `hasCommand` to a PATH lookup; both are injectable for tests.
   */
  readiness(
    server: RegistryServer,
    env: NodeJS.ProcessEnv = process.env,
    hasCommand: (command: string) => boolean = hasCommandCached,
  ): Readiness {
    const outcome = server.verification?.latestOutcome ?? null;
    const verified = outcome === "verified";
    // Our own test outranks metadata: a server that didn't start for us with no
    // credentials won't start for an agent with none either.
    const tested = (missing: string[], via: Readiness["via"], remote: RemoteEndpoint | null): Readiness => {
      if (missing.length > 0 || outcome === "needs_credentials") {
        return { level: "needs-setup", via, missing, remote, verified };
      }
      if (outcome === "failed_to_start") {
        return { level: "failed-in-test", via, missing, remote, verified };
      }
      return { level: "ready", via, missing, remote, verified };
    };

    const install = this.resolveInstallCommand(server);
    if (install) {
      const declared = (server.authDetails?.envVars ??
        (server.metadata?.authEnvVars as Array<{ name?: string }> | undefined) ??
        []) as Array<{ name?: string }>;
      const missing = declared.map((e) => e?.name).filter((n): n is string => !!n && !env[n]);
      // npx comes with the Node running this gateway; anything else must be here.
      if (install.command !== "npx" && !hasCommand(install.command)) missing.unshift(install.command);
      return tested(missing, "install", null);
    }
    const remote = this.resolveRemote(server);
    if (remote) return tested(remote.requiredHeaders, "remote", remote);
    return { level: "not-runnable", via: null, missing: [], remote: null, verified };
  }

  /**
   * Determine trust tier from registry data.
   *
   * NOTE: This logic is mirrored in the main app at src/scoring/trust-tier.ts
   * (so the REST API exposes the same `trustTier`). Keep the two in sync — the
   * gateway is a separately-published package and can't import from the root.
   */
  static determineTrustTier(server: RegistryServer): TrustTier {
    const score = server.qualityScore ?? 0;
    let tier: TrustTier;
    if (server.isVerified || (server.isOfficial && score >= 80)) {
      tier = "verified";
    } else if (score >= 60 && server.repositoryUrl && server.installCommand) {
      tier = "trusted";
    } else if (score >= 30) {
      tier = "community";
    } else {
      tier = "unknown";
    }
    // Safety cap, as MCP Rating applies it (the gateway didn't, before 0.4.0): a
    // server whose safety score is in the risk band is at most [Community], and
    // below 30 it is [Unverified], however good the rest of it looks.
    const safety = server.safetyScore;
    if (safety !== null && safety !== undefined) {
      if (safety < 30) tier = "unknown";
      else if (safety < 50 && (tier === "verified" || tier === "trusted")) tier = "community";
    }
    return tier;
  }

  /** Reachability across all registries, and of each, for diagnostics. */
  getStatus(): RegistryStatus & { registries: Array<{ label: string; kind: RegistrySource["kind"] } & RegistryStatus> } {
    const each = this.sources.map((s) => ({ label: s.label, kind: s.kind, ...s.getStatus() }));
    const successes = each.map((e) => e.lastSuccessfulCall?.getTime() ?? 0);
    const latest = Math.max(...successes);
    return {
      lastSuccessfulCall: latest > 0 ? new Date(latest) : null,
      lastError: each.filter((e) => e.lastError).map((e) => `${e.label}: ${e.lastError}`).join("; ") || null,
      cacheSize: each.reduce((n, e) => n + e.cacheSize, 0),
      registries: each,
    };
  }

  /** Clear all cached entries. */
  clearCache(): void {
    for (const s of this.sources) s.clearCache();
  }
}

/** `p`, or a rejection once `ms` have passed. `p` itself carries on (and caches what it gets). */
function withDeadline<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`no answer within ${ms / 1000}s`)), ms);
    timer.unref?.();
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

function reason(r: PromiseSettledResult<unknown>): string {
  if (r.status === "fulfilled") return "ok";
  return r.reason instanceof Error ? r.reason.message : String(r.reason);
}
