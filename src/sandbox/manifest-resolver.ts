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
  private readonly containerIsolation: boolean;

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

    const tier = TIER_DEFAULTS[trustTier];

    // Escalate untrusted tiers to container isolation when enabled.
    const enforcement: EnforcementLevel =
      this.containerIsolation &&
      (trustTier === "community" || trustTier === "unknown")
        ? "l2-container"
        : tier.enforcement;

    // Build the env allowlist from the server's declared auth vars plus any
    // vars the user explicitly passed (they clearly intend those to flow).
    const declaredEnv = (registryServer?.authDetails?.envVars ?? []).map(
      (e) => e.name,
    );
    const allEnv = new Set<string>([...declaredEnv, ...userProvidedEnvKeys]);

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

    // Network
    switch (manifest.network.mode) {
      case "none":
        lines.push("No network access (declared)");
        break;
      case "allowlist":
        lines.push(
          manifest.network.allow.length > 0
            ? `Network limited to: ${manifest.network.allow.join(", ")} (declared)`
            : "Network: allowlist (none specified) (declared)",
        );
        break;
      case "all":
        lines.push("Full network access (declared)");
        sensitive = true;
        break;
    }

    // Filesystem
    const fsRead = manifest.filesystem.read.length;
    const fsWrite = manifest.filesystem.write.length;
    if (fsRead > 0 || fsWrite > 0) {
      lines.push(
        `Filesystem: ${fsRead} read path(s), ${fsWrite} write path(s) (declared)`,
      );
      if (fsWrite > 0) sensitive = true;
    }

    // Subprocess
    if (manifest.subprocess) {
      lines.push("May spawn subprocesses (declared)");
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
