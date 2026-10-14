/** Server data returned by the MCP-Rating API */
export interface RegistryServer {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  author: string | null;
  repositoryUrl: string | null;
  npmPackage: string | null;
  homepage: string | null;
  installCommand: string | null;
  stars: number | null;
  weeklyDownloads: number | null;
  qualityScore: number | null;
  isOfficial: boolean;
  isVerified: boolean;
  supportsDiscovery: boolean;
  discoveryUrl: string | null;
  /** Heuristic UI capability from the registry ("UI-capable (detected)"). */
  supportsUi?: boolean;
  uiType?: string | null;
  /** How the server is run: npm | pypi | docker | remote | github-manual. */
  accessMethod?: string | null;
  /** Supply-chain safety screen, 0-100 (>=80 safe, 50-79 caution, <50 risk). */
  safetyScore?: number | null;
  safetyFlags?: string[] | null;
  category: { slug: string; name: string } | null;
  tools: { name: string; description: string | null }[];
  resources: { uri: string; name: string; description: string | null }[];
  metadata: Record<string, unknown> | null;
  /** Whether this server requires API keys or authentication (computed from metadata) */
  requiresAuth?: boolean;
  /** Detailed auth info (computed from metadata) */
  authDetails?: {
    envVars: Array<{ name: string; description?: string }>;
    allEnvVars: Array<{ name: string; description?: string }>;
    schemes: string[];
  } | null;
  /**
   * The registry's own attempt to start this server: no credentials, one
   * machine, on a schedule. `null` means never attempted, which is not failure.
   */
  verification?: {
    latestOutcome: "verified" | "needs_credentials" | "failed_to_start" | "unsupported" | string;
    lastAttemptedAt: string;
    lastVerifiedAt: string | null;
    attemptCount: number;
    verifiedCount: number;
  } | null;
  /** The registry this came from (its host), set by the source that returned it. */
  source?: string;
  /** The server's official registry name (`io.github.owner/server`), when it has one. */
  registryName?: string | null;
  /**
   * For a server from another registry: MCP Rating's record of the same
   * package, whose score, safety and start test this row now carries.
   */
  rating?: { by: string; slug: string; url: string };
  /** MCP Rating doesn't list this package, and why (its delisting reason). */
  delistedReason?: string | null;
  /** The registry name points somewhere MCP Rating knows as a different package. */
  trustWarning?: string;
  /** For a rated server from another registry: MCP Rating's upkeep facts for the package. */
  maintenance?: import("./trust-facts.js").Maintenance;
  /**
   * What mcp_connect takes to find this server again, in any session: its slug,
   * or — for a registry that keys servers by name — its registry name. Unset
   * means the slug.
   */
  ref?: string;
}

/** Paginated list response from the API */
export interface RegistryListResponse {
  data: RegistryServer[];
  total: number;
  limit: number;
  offset: number;
  /** Registries that didn't answer this search, when others did. */
  unreachable?: string[];
}

/** Trust tiers derived from registry data */
export type TrustTier = "verified" | "trusted" | "community" | "unknown";

/** Resolved install command for spawning a server */
export interface InstallCommand {
  command: string;
  args: string[];
}
