import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { TrustTier } from "../registry/types.js";
import type { CapabilityManifest } from "../sandbox/types.js";
import type { EgressProxy } from "../sandbox/egress-proxy.js";

// ── Transport Types ──────────────────────────────────────────────────────────

export type TransportType = "stdio" | "sse" | "websocket" | "streamable-http";

// ── Connection States ────────────────────────────────────────────────────────

export type ConnectionState =
  | "connecting"
  | "ready"
  | "reconnecting"
  | "failed"
  | "error"
  | "disconnecting";

// ── Downstream Descriptors ───────────────────────────────────────────────────

/** Whether a downstream tool supports task-based (long-running) execution. */
export type TaskSupport = "optional" | "required" | "forbidden";

export interface DownstreamTool {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
  annotations?: Record<string, unknown>;
  /**
   * Tool execution hints from the downstream server. `taskSupport` of
   * "optional" or "required" means the tool runs as an experimental MCP
   * task and must be proxied through the task lifecycle, not a plain call.
   */
  execution?: { taskSupport?: TaskSupport };
  /**
   * Tool-level _meta. Used to detect MCP Apps UI capability via
   * `_meta.ui.resourceUri` (authoritative, live).
   */
  _meta?: Record<string, unknown>;
}

export interface DownstreamResource {
  /** The resource URI as exposed by the downstream server */
  uri: string;
  name: string;
  description?: string;
  mimeType?: string;
}

export interface DownstreamPrompt {
  name: string;
  description?: string;
  arguments?: Array<{
    name: string;
    description?: string;
    required?: boolean;
  }>;
}

// ── Connection Object ────────────────────────────────────────────────────────

export interface DownstreamConnection {
  slug: string;
  displayName: string;
  state: ConnectionState;
  client: Client;
  transport: Transport;
  transportType: TransportType;
  tools: Map<string, DownstreamTool>;
  resources: Map<string, DownstreamResource>;
  prompts: Map<string, DownstreamPrompt>;
  /** Map of namespaced tool name → remove() handle */
  registeredProxies: Map<string, { remove: () => void }>;
  /** Map of namespaced resource URI → remove() handle */
  registeredResourceProxies: Map<string, { remove: () => void }>;
  /** Map of namespaced prompt name → remove() handle */
  registeredPromptProxies: Map<string, { remove: () => void }>;
  connectedAt: Date;
  lastError?: string;
  trustTier: TrustTier;
  serverInfo?: { name: string; version: string };

  /** Resolved sandbox capability manifest (L1+) for this connection */
  manifest?: CapabilityManifest;

  /** Egress allowlist proxy (L2 network:allowlist mode) — stopped on disconnect */
  egressProxy?: EgressProxy;

  /** Original connect params — stored for auto-reconnect */
  originalParams?: ConnectParams;
  /** Current reconnect attempt count (reset on successful reconnect) */
  reconnectAttempts: number;

  /** Consecutive failed health-check pings (reset on success) */
  failedPings: number;
  /** Timestamp of last successful ping */
  lastPingAt?: Date;
}

// ── Connect Parameters ───────────────────────────────────────────────────────

export interface ConnectParams {
  /** Server slug from MCP-Rating registry */
  slug?: string;
  /** Explicit command to spawn (stdio transport) */
  command?: string;
  /** Command arguments */
  args?: string[];
  /** Additional environment variables */
  env?: Record<string, string>;
  /** User has explicitly confirmed connection (required for community/unknown tier) */
  confirmed?: boolean;
  /** Save this connection as an auto-connect profile */
  saveProfile?: boolean;
  /** Transport type — defaults to "stdio" */
  transportType?: TransportType;
  /** URL for remote transports (SSE, WebSocket, Streamable HTTP) */
  url?: string;
}

// ── Connection Summary ───────────────────────────────────────────────────────

export interface ConnectionSummary {
  slug: string;
  displayName: string;
  state: ConnectionState;
  trustTier: TrustTier;
  transportType: TransportType;
  toolCount: number;
  resourceCount: number;
  promptCount: number;
  connectedAt: Date;
  serverInfo?: { name: string; version: string };
  reconnectAttempts?: number;
  failedPings?: number;
  lastPingAt?: Date;
}

// ── Confirmation ─────────────────────────────────────────────────────────────

/** Returned when a connection requires user confirmation before proceeding */
export interface ConfirmationRequired {
  needsConfirmation: true;
  slug: string;
  displayName: string;
  trustTier: TrustTier;
  warning: string;
}

/** Result of a connect() call — either a connection summary or a confirmation request */
export type ConnectResult = ConnectionSummary | ConfirmationRequired;

/** Type guard to check if a connect result requires confirmation */
export function isConfirmationRequired(result: ConnectResult): result is ConfirmationRequired {
  return "needsConfirmation" in result && result.needsConfirmation === true;
}
