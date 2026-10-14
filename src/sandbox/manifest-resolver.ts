import { readFileSync, writeFileSync, existsSync } from "node:fs";
import type { TrustTier, RegistryServer } from "../registry/types.js";
import { log } from "../utils/logger.js";
import type {
  CapabilityManifest,
  EnforcementLevel,
  ManifestSummary,
  NetworkMode,
} from "./types.js";

interface PersistedManifests {
  manifests: Record<string, CapabilityManifest>;
}

/**
 * Trust-tier → default policy mapping.
 *
 * The principle: the less we trust a server, the less it gets by default.
 * Verified/trusted servers get permissive defaults (they've earned it);
 * community/unknown servers get locked down and must be explicitly granted.
 */
const TIER_DEFAULTS: Record<
  TrustTier,
  {
    enforcement: EnforcementLevel;
    inheritDefaults: boolean;
    network: NetworkMode;
    subprocess: boolean;
  }
> = {
  verified: {
    enforcement: "l1-process",
    inheritDefaults: true,
    network: "all",
    subprocess: true,
  },
  trusted: {
    enforcement: "l1-process",
    inheritDefaults: true,
    network: "all",
    subprocess: true,
  },
  community: {
    enforcement: "l1-process",
    inheritDefaults: true,
    network: "allowlist",
    subprocess: false,
  },
  unknown: {
    enforcement: "l1-process",
    inheritDefaults: true, // still need PATH/HOME to start
    network: "none",
    subprocess: false,
  },
};

/**
 * The manifest a server with no saved override gets: its trust tier's
 * defaults and the auth env vars its registry record declares. Pure, so
 * mcp_sandbox "set" can start from exactly what a connect would resolve.
 * (A connect then adds the env names passed to it: withConnectEnv.)
 */
export function tierDefaults(
  slug: string,
  trustTier: TrustTier,
  opts: {
    /** Escalate community/unknown to l2-container (MCP_GATEWAY_CONTAINER_ISOLATION). */
    containerIsolation: boolean;
    registryServer?: RegistryServer | null;
  },
): CapabilityManifest {
  const tier = TIER_DEFAULTS[trustTier];

  // Escalate untrusted tiers to container isolation when enabled.
  const enforcement: EnforcementLevel =
    opts.containerIsolation &&
    (trustTier === "community" || trustTier === "unknown")
      ? "l2-container"
      : tier.enforcement;

  // The env allowlist is the server's declared auth vars.
  const declaredEnv = (opts.registryServer?.authDetails?.envVars ?? []).map(
    (e) => e.name,
  );

  return {
    version: 1,
    slug,
    enforcement,
    env: {
      allow: [...new Set(declaredEnv)],
      inheritDefaults: tier.inheritDefaults,
    },
    network: {
      mode: tier.network,
      allow: [],
    },
    filesystem: {
      read: [],
      write: [],
    },
    subprocess: tier.subprocess,
  };
}

/**
 * `manifest` as one connect applies it: with the env var names passed to that
 * connect allowed too, saved override or not. The user handed the server
 * those values, and buildScopedEnvironment always lets them through, but
 * under L2 only names in env.allow are forwarded into the container. An
 * override used to be applied as saved, so a contained server with one never
 * received them.
 *
 * Returns `manifest` itself when there is nothing to add; never changes it,
 * since it may be the saved override.
 */
export function withConnectEnv(
  manifest: CapabilityManifest,
  userProvidedEnvKeys: string[],
): CapabilityManifest {
  const added = [...new Set(userProvidedEnvKeys)].filter((k) => !manifest.env.allow.includes(k));
  if (added.length === 0) return manifest;
  return { ...manifest, env: { ...manifest.env, allow: [...manifest.env.allow, ...added] } };
}

/**
 * What would put a server that runs outside a container into one, for the
 * summary to tell the user. The summary used to say "set
 * MCP_GATEWAY_CONTAINER_ISOLATION=true" for every such server, including ones
 * that setting can't move: where it was already on and the server was
 * verified, trusted, or had fallen back for want of an engine.
 *  - "start-engine": its manifest asks for l2-container, but no Docker or
 *    Podman was found when it connected.
 *  - "enable-isolation": the setting is off, and turning it on would do it,
 *    as the server is community or unknown with no saved override.
 *  - "set-enforcement": only an override asking for l2-container would: its
 *    tier stays on L1 even under isolation, or a saved override says L1.
 */
export type ContainmentRemedy = "start-engine" | "enable-isolation" | "set-enforcement";

export function containmentRemedy(opts: {
  /** What the connect resolved, before any fallback to L1 (resolvedManifest). */
  resolved: CapabilityManifest;
  trustTier: TrustTier;
  containerIsolation: boolean;
  hasOverride: boolean;
}): ContainmentRemedy {
  if (opts.resolved.enforcement === "l2-container") return "start-engine";
  const escalates = opts.trustTier === "community" || opts.trustTier === "unknown";
  if (!opts.containerIsolation && escalates && !opts.hasOverride) return "enable-isolation";
  return "set-enforcement";
}

/**
 * What is known about a slug's trust tier outside a connect: what its live
 * connection was given, else what the registry said.
 */
export type TrustLookup =
  /** The tier and registry record (null if none) the live connection's connect used. */
  | { status: "connection"; trustTier: TrustTier; server: RegistryServer | null }
  /** The same, from the latest connect attempt, when nothing is connected. */
  | { status: "last-connect"; trustTier: TrustTier; server: RegistryServer | null }
  | { status: "found"; server: RegistryServer; trustTier: TrustTier }
  /**
   * Not a registry slug: what a connect by command or URL produces, whose
   * tier then comes from what MCP Rating knows of the package it runs.
   */
  | { status: "not-found" }
  | { status: "unreachable" };

/**
 * A registry name (`io.github.owner/server`) rather than a slug. Slugs are
 * tool-name-safe and never have a "/"; RegistryClient.getServer looks a ref
 * with one up by name.
 */
export function isRegistryName(ref: string): boolean {
  return ref.includes("/");
}

/**
 * The slug mcp_sandbox files a server's override under: the one a connect
 * gives it. A registry name (`io.github.owner/server`: anything with a "/")
 * becomes the slug of the server the registry has under it, as connect does,
 * since a name's "/" and "." can't go into tool names. Anything else is used
 * as given. An override filed under the name itself was never applied: a
 * connect by name looks overrides up by that slug.
 *
 * `byName` is the registry's answer for a name, and is needed only for one.
 * A name it doesn't know, or couldn't be asked about, gets no slug: no
 * connect would ever use an override filed under a guess.
 */
export function overrideSlug(
  ref: string,
  byName?: TrustLookup,
): { slug: string } | { error: string } {
  if (!isRegistryName(ref)) return { slug: ref };
  if (byName?.status === "found") return { slug: byName.server.slug };
  if (byName?.status === "not-found") {
    return {
      error: `No registry has a server named "${ref}", so no connect would use an override for it: a connect by that name fails. Check the name with mcp_discover, or pass the server's slug.`,
    };
  }
  return {
    error: `"${ref}" is a registry name, and an override is saved under the slug a connect gives the server, which takes a registry to find. No registry answered: try again, or pass the slug (mcp_list_active shows it once the server is connected).`,
  };
}

/** The fields mcp_sandbox "set" changes. One left out keeps its current value. */
export interface ManifestChanges {
  enforcement?: EnforcementLevel;
  network?: NetworkMode;
  networkAllow?: string[];
  envAllow?: string[];
  fsRead?: string[];
  fsWrite?: string[];
  subprocess?: boolean;
}

/** What an override was built on, so mcp_sandbox can tell the user. */
export type OverrideStart =
  | { from: "override" }
  | { from: "defaults"; trustTier: TrustTier; lookup: TrustLookup["status"] };

/**
 * The override mcp_sandbox "set" saves: `changes` applied to what the server's
 * next connect would otherwise resolve. That is its saved override, else the
 * defaults for its trust tier, declared env vars included. (A fixed
 * l1-process baseline used to stand in for the defaults, so changing only the
 * network also dropped the container and the declared env vars.)
 *
 * A live connection only says which tier and registry record those defaults
 * come from. Its own manifest is no base: it adds the env names passed to that
 * connect (withConnectEnv), which an override would keep allowing on every
 * later connect, from the gateway's environment; it may run as l1-process for
 * want of a container engine; and it may come from an override since reset.
 *
 * With nothing connected, the latest connect attempt says the same, even a
 * refused or failed one. Otherwise the tier comes from the registry. A slug it
 * doesn't have gets "unknown": it is most likely made from a command, whose
 * connect takes its tier from MCP Rating's record of the package it runs,
 * and the package can't be recovered from the slug. So does a slug the
 * registry couldn't be asked about, since the most locked-down tier is the
 * only honest guess. The caller needs `lookup` only when there is no saved
 * override.
 */
export function overrideForSet(
  slug: string,
  changes: ManifestChanges,
  current: {
    saved?: CapabilityManifest;
    lookup?: TrustLookup;
  },
  containerIsolation: boolean,
): { manifest: CapabilityManifest; start: OverrideStart } {
  let base: CapabilityManifest;
  let start: OverrideStart;
  if (current.saved) {
    base = current.saved;
    start = { from: "override" };
  } else {
    const lookup: TrustLookup = current.lookup ?? { status: "unreachable" };
    const known =
      lookup.status === "found" || lookup.status === "connection" || lookup.status === "last-connect"
        ? lookup
        : null;
    const trustTier = known?.trustTier ?? "unknown";
    base = tierDefaults(slug, trustTier, {
      containerIsolation,
      registryServer: known?.server,
    });
    start = { from: "defaults", trustTier, lookup: lookup.status };
  }

  const manifest: CapabilityManifest = {
    ...base,
    slug,
    enforcement: changes.enforcement ?? base.enforcement,
    env: {
      allow: changes.envAllow ?? base.env.allow,
      inheritDefaults: base.env.inheritDefaults,
    },
    network: {
      mode: changes.network ?? base.network.mode,
      allow: changes.networkAllow ?? base.network.allow,
    },
    filesystem: {
      read: changes.fsRead ?? base.filesystem.read,
      write: changes.fsWrite ?? base.filesystem.write,
    },
    subprocess: changes.subprocess ?? base.subprocess,
  };
  return { manifest, start };
}

/**
 * Resolves and persists per-server capability manifests.
 *
 * A manifest is derived from (in priority order):
 *   1. A user-saved override (persisted to disk)
 *   2. Trust-tier defaults + the server's declared auth env vars
 */
export class ManifestResolver {
  private overrides = new Map<string, CapabilityManifest>();
  private readonly filePath: string;
  /**
   * When true, untrusted tiers (community/unknown) default to l2-container
   * enforcement instead of l1-process. Verified/trusted stay on L1.
   */
  readonly containerIsolation: boolean;

  constructor(filePath: string, containerIsolation = false) {
    this.filePath = filePath;
    this.containerIsolation = containerIsolation;
    this.loadFromDisk();
  }

  /**
   * Resolve the effective manifest for a server. Uses a saved override if one
   * exists; otherwise derives defaults from the trust tier and the server's
   * declared auth env vars (so e.g. a GitHub server gets GITHUB_TOKEN allowed
   * but nothing else). Either way, the env names passed to this connect are
   * allowed too.
   */
  resolve(
    slug: string,
    trustTier: TrustTier,
    registryServer?: RegistryServer | null,
    /** Env var names the user explicitly supplied at connect time. */
    userProvidedEnvKeys: string[] = [],
  ): CapabilityManifest {
    const override = this.overrides.get(slug);
    if (override) {
      log.debug("Using saved manifest override", { slug });
    }
    const manifest =
      override ??
      tierDefaults(slug, trustTier, {
        containerIsolation: this.containerIsolation,
        registryServer,
      });
    return withConnectEnv(manifest, userProvidedEnvKeys);
  }

  /** Get a saved override for a slug, if one exists. */
  getOverride(slug: string): CapabilityManifest | undefined {
    return this.overrides.get(slug);
  }

  /** Persist a user-customized manifest. */
  saveOverride(manifest: CapabilityManifest): void {
    this.overrides.set(manifest.slug, manifest);
    this.saveToDisk();
  }

  /** Remove a saved override, reverting to trust-tier defaults. */
  clearOverride(slug: string): void {
    if (this.overrides.delete(slug)) this.saveToDisk();
  }

  /**
   * Overrides filed under a registry name instead of a slug. mcp_sandbox
   * saved them that way before it resolved names (overrideSlug), and no
   * connect ever applied one, since a connect looks overrides up by slug.
   * They stay until removed by that name; this is how they're found.
   */
  nameKeyedOverrides(): string[] {
    return [...this.overrides.keys()].filter(isRegistryName);
  }

  /**
   * Build a human-readable summary of a manifest for the HITL prompt.
   * `remedy` says what would contain the server when it runs outside a
   * container (containmentRemedy); the default is the one that always applies.
   */
  static summarize(
    manifest: CapabilityManifest,
    remedy: ContainmentRemedy = "set-enforcement",
  ): ManifestSummary {
    const lines: string[] = [];
    let sensitive = false;

    // Environment
    if (manifest.env.allow.length > 0) {
      lines.push(
        `Read ${manifest.env.allow.length} environment variable(s): ${manifest.env.allow.join(", ")}`,
      );
      sensitive = true;
    } else {
      lines.push("No environment variables (secrets) exposed");
    }

    // Network and filesystem limits are enforced only inside a container. The
    // model relays these lines to the user, so outside one they must say
    // "not restricted" — "No network access (declared)" read as a guarantee
    // for a process that could reach anything and read the whole home folder.
    const contained = manifest.enforcement === "l2-container";

    // Network
    if (!contained) {
      lines.push("Network: not restricted (limits apply only with container isolation)");
    } else {
      switch (manifest.network.mode) {
        case "none":
          lines.push("No network access (container has no network)");
          break;
        case "allowlist":
          lines.push(
            manifest.network.allow.length > 0
              ? `Network limited to: ${manifest.network.allow.join(", ")} (proxy-aware clients only)`
              : "Network: allowlist with no hosts (proxy-aware clients only)",
          );
          break;
        case "all":
          lines.push("Full network access");
          sensitive = true;
          break;
      }
    }

    // Filesystem
    if (!contained) {
      const toRestrict = {
        "start-engine":
          "its sandbox asks for a container, but no Docker or Podman was found; start one and reconnect to restrict",
        "enable-isolation": "set MCP_GATEWAY_CONTAINER_ISOLATION=true to restrict",
        "set-enforcement": `to restrict, run it in a container, which needs Docker or Podman: mcp_sandbox({action: "set", slug: ${JSON.stringify(manifest.slug)}, enforcement: "l2-container"})`,
      }[remedy];
      lines.push(
        `Files: not restricted, so it can read what your user can, including ~/.ssh and ~/.aws (${toRestrict})`,
      );
    } else {
      const fsRead = manifest.filesystem.read.length;
      const fsWrite = manifest.filesystem.write.length;
      lines.push(
        fsRead > 0 || fsWrite > 0
          ? `Files: ${fsRead} read path(s), ${fsWrite} write path(s) mounted; nothing else from the host`
          : "Files: nothing from the host is mounted",
      );
      if (fsWrite > 0) sensitive = true;
    }

    // Subprocess — declared only; no level enforces it yet.
    if (manifest.subprocess) {
      lines.push("May spawn subprocesses (declared, not enforced)");
      sensitive = true;
    }

    return { enforcement: manifest.enforcement, lines, hasSensitiveGrants: sensitive };
  }

  private loadFromDisk(): void {
    if (!existsSync(this.filePath)) return;
    try {
      const raw = readFileSync(this.filePath, "utf-8");
      const data = JSON.parse(raw) as PersistedManifests;
      for (const [slug, manifest] of Object.entries(data.manifests || {})) {
        this.overrides.set(slug, manifest);
      }
      log.debug("Loaded manifest overrides", { count: this.overrides.size });
    } catch {
      log.warn("Failed to load manifests file, using tier defaults");
    }
  }

  private saveToDisk(): void {
    const data: PersistedManifests = { manifests: {} };
    for (const [slug, manifest] of this.overrides) {
      data.manifests[slug] = manifest;
    }
    try {
      writeFileSync(this.filePath, JSON.stringify(data, null, 2), "utf-8");
    } catch (err) {
      log.warn("Failed to save manifests", { error: String(err) });
    }
  }
}
