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
 * defaults, the auth env vars its registry record declares, and any env names
 * the user passed at connect. Pure, so mcp_sandbox "set" can start from
 * exactly what a connect would resolve.
 */
export function tierDefaults(
  slug: string,
  trustTier: TrustTier,
  opts: {
    /** Escalate community/unknown to l2-container (MCP_GATEWAY_CONTAINER_ISOLATION). */
    containerIsolation: boolean;
    registryServer?: RegistryServer | null;
    /** Env var names the user explicitly supplied at connect time. */
    userProvidedEnvKeys?: string[];
  },
): CapabilityManifest {
  const tier = TIER_DEFAULTS[trustTier];

  // Escalate untrusted tiers to container isolation when enabled.
  const enforcement: EnforcementLevel =
    opts.containerIsolation &&
    (trustTier === "community" || trustTier === "unknown")
      ? "l2-container"
      : tier.enforcement;

  // Build the env allowlist from the server's declared auth vars plus any
  // vars the user explicitly passed (they clearly intend those to flow).
  const declaredEnv = (opts.registryServer?.authDetails?.envVars ?? []).map(
    (e) => e.name,
  );
  const allEnv = new Set<string>([...declaredEnv, ...(opts.userProvidedEnvKeys ?? [])]);

  return {
    version: 1,
    slug,
    enforcement,
    env: {
      allow: [...allEnv],
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

/** What the registry said when asked about a slug outside a connect. */
export type TrustLookup =
  | { status: "found"; server: RegistryServer; trustTier: TrustTier }
  /** Not a registry slug: what connects by command or URL produce. */
  | { status: "not-found" }
  | { status: "unreachable" };

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
  | { from: "connection" }
  | { from: "defaults"; trustTier: TrustTier; lookup: TrustLookup["status"] };

/**
 * The override mcp_sandbox "set" saves: `changes` applied to what the server
 * would otherwise run with. That is its saved override, else the manifest its
 * live connection resolved, else what a connect would resolve — the defaults
 * for its trust tier. (A fixed l1-process baseline used to stand in for the
 * last, so changing only the network also dropped the container and the
 * server's declared env vars.)
 *
 * The tier comes from `lookup`, which the caller needs to make only when
 * there is neither a saved override nor a live manifest. A slug the registry
 * doesn't have gets "unknown", as a connect by command or URL does; so does
 * one it couldn't be asked about, since the most locked-down tier is the only
 * honest guess.
 */
export function overrideForSet(
  slug: string,
  changes: ManifestChanges,
  current: {
    saved?: CapabilityManifest;
    live?: CapabilityManifest;
    lookup?: TrustLookup;
  },
  containerIsolation: boolean,
): { manifest: CapabilityManifest; start: OverrideStart } {
  let base: CapabilityManifest;
  let start: OverrideStart;
  if (current.saved) {
    base = current.saved;
    start = { from: "override" };
  } else if (current.live) {
    base = current.live;
    start = { from: "connection" };
  } else {
    const lookup: TrustLookup = current.lookup ?? { status: "unreachable" };
    const found = lookup.status === "found" ? lookup : null;
    const trustTier = found?.trustTier ?? "unknown";
    base = tierDefaults(slug, trustTier, {
      containerIsolation,
      registryServer: found?.server,
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
   * but nothing else).
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
      return override;
    }

    return tierDefaults(slug, trustTier, {
      containerIsolation: this.containerIsolation,
      registryServer,
      userProvidedEnvKeys,
    });
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
   * Build a human-readable summary of a manifest for the HITL prompt.
   */
  static summarize(manifest: CapabilityManifest): ManifestSummary {
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
      lines.push(
        "Files: not restricted, so it can read what your user can, including ~/.ssh and ~/.aws (set MCP_GATEWAY_CONTAINER_ISOLATION=true to restrict)",
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
