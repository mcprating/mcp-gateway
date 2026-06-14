export interface GatewayConfig {
  /** MCP-Rating API base URL for registry lookups */
  registryApiUrl: string;

  /** Timeout for proxied tool calls in milliseconds */
  proxyTimeoutMs: number;

  /** Maximum simultaneous downstream server connections */
  maxConnections: number;

  /** Log level (stderr only — stdout is MCP JSON-RPC) */
  logLevel: "debug" | "info" | "warn" | "error";

  /** Path to permissions persistence file */
  permissionsPath: string;

  /** Path to gateway config file */
  configPath: string;

  /** Path to connection profiles file for auto-connect on startup */
  profilesPath: string;

  /** TTL for registry API cache entries in milliseconds (default 300_000 = 5 min) */
  registryCacheTtlMs: number;

  /** Max reconnect attempts when a downstream server crashes (default 5) */
  reconnectMaxAttempts: number;

  /** Base delay in ms for exponential reconnect backoff (default 1000) */
  reconnectBaseDelayMs: number;

  /** Interval in ms between health check pings (default 30_000) */
  healthCheckIntervalMs: number;

  /** Optional partner API key for ad tracking (ptr_*) */
  partnerKey?: string;

  /** Whether to enable ad tracking (default: true if partnerKey set) */
  enableAdTracking?: boolean;

  /** Whether to enable auto-install for missing commands (default: true) */
  enableAutoInstall?: boolean;

  /** Whether to enable usage analytics tracking (default: true) */
  enableUsageTracking?: boolean;

  /** Size of the usage analytics ring buffer (default: 10000) */
  usageBufferSize?: number;

  /** Whether to enable auto-recommend based on usage patterns (default: true) */
  enableAutoRecommend?: boolean;

  /** Path to server groups file */
  groupsPath?: string;

  /**
   * Optional path for the durable safety audit log (JSONL, append-only). When
   * set, every sandbox-relevant event (tool calls, blocked tools, blocked/
   * allowed egress, connects) is appended for forensics / SIEM ingestion.
   * When unset, the audit trail is in-memory only (queryable via mcp_audit).
   */
  auditLogPath?: string;

  /**
   * Whether to enable L2 container isolation (Docker/Podman) for untrusted
   * servers. Default: false (opt-in). When true, community/unknown-tier
   * servers run inside a constrained container; verified/trusted stay on L1.
   * Falls back to L1 automatically if no container engine is available.
   */
  enableContainerIsolation?: boolean;

  /** HTTP daemon port. When set, the gateway runs as an HTTP daemon. */
  httpPort?: number;
  /** HTTP daemon bind host (default 127.0.0.1). */
  httpHost?: string;
  /** Bearer token required for HTTP daemon requests (single-tenant mode). */
  httpToken?: string;
  /**
   * Per-tenant bearer tokens: tenantId → token. Enables a multi-tenant daemon
   * where each tenant authenticates with its own token and gets an isolated
   * session pool + sandbox-manifest store. Merged with `httpToken` (which maps
   * to tenant "default").
   */
  httpTokens?: Record<string, string>;
  /**
   * Allowed Host header values (DNS-rebinding protection). If unset, a safe
   * default of localhost variants on the bind port is used. Set explicitly
   * (e.g. ["gateway.example.com"]) when binding to 0.0.0.0 behind a domain.
   */
  httpAllowedHosts?: string[];
  /**
   * Allowed Origin header values. Browser requests carrying any other Origin
   * are rejected. Non-browser clients (no Origin header) are always allowed.
   */
  httpAllowedOrigins?: string[];
}
