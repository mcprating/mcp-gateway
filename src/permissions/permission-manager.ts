import { readFileSync, writeFileSync, existsSync } from "node:fs";
import type { GatewayConfig } from "../config/types.js";
import type { TrustTier } from "../registry/types.js";
import { log } from "../utils/logger.js";

export interface ServerPermissions {
  slug: string;
  trustTier: TrustTier;
  allowedTools: string[] | "all";
  blockedTools: string[];
  autoConnect: boolean;
}

interface PersistedPermissions {
  servers: Record<string, Omit<ServerPermissions, "slug">>;
}

/**
 * Manages per-server permissions with file-based persistence.
 *
 * In Phase 1 this is primarily informational — the host client's
 * built-in HITL confirmation (tool call approval dialog) serves as
 * the primary permission gate.
 */
export class PermissionManager {
  private permissions = new Map<string, ServerPermissions>();
  private readonly filePath: string;

  constructor(config: GatewayConfig) {
    this.filePath = config.permissionsPath;
    this.loadFromDisk();
  }

  getPermissions(slug: string, trustTier: TrustTier): ServerPermissions {
    const existing = this.permissions.get(slug);
    if (existing) return existing;

    // Return defaults for this trust tier
    return {
      slug,
      trustTier,
      allowedTools: "all",
      blockedTools: [],
      autoConnect: trustTier === "verified" || trustTier === "trusted",
    };
  }

  setPermissions(slug: string, perms: ServerPermissions): void {
    this.permissions.set(slug, perms);
    this.saveToDisk();
  }

  isToolAllowed(slug: string, toolName: string): boolean {
    const perms = this.permissions.get(slug);
    if (!perms) return true; // No restrictions stored → allow

    if (perms.blockedTools.includes(toolName)) return false;
    if (perms.allowedTools === "all") return true;
    return perms.allowedTools.includes(toolName);
  }

  private loadFromDisk(): void {
    if (!existsSync(this.filePath)) return;

    try {
      const raw = readFileSync(this.filePath, "utf-8");
      const data = JSON.parse(raw) as PersistedPermissions;
      for (const [slug, perms] of Object.entries(data.servers || {})) {
        this.permissions.set(slug, { slug, ...perms });
      }
      log.debug("Loaded permissions", { count: this.permissions.size });
    } catch {
      log.warn("Failed to load permissions file, using defaults");
    }
  }

  private saveToDisk(): void {
    const data: PersistedPermissions = { servers: {} };
    for (const [slug, perms] of this.permissions) {
      const { slug: _slug, ...rest } = perms;
      data.servers[slug] = rest;
    }

    try {
      writeFileSync(this.filePath, JSON.stringify(data, null, 2), "utf-8");
    } catch (err) {
      log.warn("Failed to save permissions", { error: String(err) });
    }
  }
}
