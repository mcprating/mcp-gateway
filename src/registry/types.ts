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
}

/** Paginated list response from the API */
export interface RegistryListResponse {
  data: RegistryServer[];
  total: number;
  limit: number;
  offset: number;
}

/** Trust tiers derived from registry data */
export type TrustTier = "verified" | "trusted" | "community" | "unknown";

/** Resolved install command for spawning a server */
export interface InstallCommand {
  command: string;
  args: string[];
}
