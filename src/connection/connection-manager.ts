import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { GatewayConfig } from "../config/types.js";
import type { RegistryClient } from "../registry/registry-client.js";
import type { PermissionManager } from "../permissions/permission-manager.js";
import type { TrustTier, RegistryServer } from "../registry/types.js";
import type { ManifestResolver } from "../sandbox/manifest-resolver.js";
import type { CapabilityManifest } from "../sandbox/types.js";
import { buildScopedEnvironment } from "../sandbox/env-scoper.js";
import {
  detectContainerEngine,
  buildContainerCommand,
  resolveBakedImage,
} from "../sandbox/container-runtime.js";
import { EgressProxy } from "../sandbox/egress-proxy.js";
import type { AuditLog } from "../audit/audit-log.js";
import type { UsageTracker } from "../analytics/usage-tracker.js";
import type { PluginManager } from "../plugins/plugin-manager.js";
import {
  registerProxiedTools,
  removeProxiedTools,
} from "../proxy/tool-router.js";
import {
  registerProxiedResources,
  removeProxiedResources,
} from "../proxy/resource-router.js";
import {
  registerProxiedPrompts,
  removeProxiedPrompts,
} from "../proxy/prompt-router.js";
import { createTransport } from "./transport-factory.js";
import type {
  DownstreamConnection,
  ConnectParams,
  ConnectionSummary,
  ConnectResult,
  ConfirmationRequired,
  DownstreamTool,
  DownstreamResource,
  DownstreamPrompt,
  TransportType,
} from "./types.js";
import {
  ConnectionError,
  DuplicateConnectionError,
  MaxConnectionsError,
  PermissionDeniedError,
} from "../utils/errors.js";
import { getTrustPolicy } from "../permissions/trust-tiers.js";
import { log } from "../utils/logger.js";
import { loadProfiles, addProfile, removeProfile } from "../config/profiles.js";
import { ensureInstalled } from "./auto-installer.js";
import type { AdTracker } from "../ads/ad-tracker.js";

/**
 * Manages the lifecycle of all downstream MCP server connections.
 *
 * Responsibilities:
 * - Connect to downstream servers via stdio, SSE, WebSocket, or Streamable HTTP
 * - Register/remove proxied tools, resources, and prompts on the gateway
 * - Handle process crashes with auto-reconnect
 * - Periodic health monitoring via pings
 * - Notify the host client when tool/resource/prompt lists change
 */
export class ConnectionManager {
  private connections = new Map<string, DownstreamConnection>();
  /** Debounce timers for tool re-sync per slug to prevent notification spam */
  private resyncTimers = new Map<string, ReturnType<typeof setTimeout>>();
  /** Active reconnect timers per slug */
  private reconnectTimers = new Map<string, ReturnType<typeof setTimeout>>();
  /** Health check interval handle */
  private healthCheckInterval: ReturnType<typeof setInterval> | null = null;
  /** Gateway start time for uptime calculation */
  readonly startedAt = new Date();

  /** Optional usage tracker for analytics */
  usageTracker?: UsageTracker;
  /** Optional plugin manager for middleware hooks */
  pluginManager?: PluginManager;
  /** Optional sandbox manifest resolver (L1 capability enforcement) */
  manifestResolver?: ManifestResolver;
  /** Optional safety audit trail (forensics log of sandboxed-server actions) */
  auditLog?: AuditLog;

  constructor(
    private readonly mcpServer: McpServer,
    private readonly registryClient: RegistryClient,
    private readonly permissionManager: PermissionManager,
    private readonly config: GatewayConfig,
    private readonly adTracker?: AdTracker | null,
  ) {}

  /**
   * Connect to a downstream MCP server.
   *
   * Resolves the install command (from registry or explicit params),
   * connects via the appropriate transport, performs MCP handshake,
   * fetches tools/resources/prompts, and registers proxied capabilities.
   */
  async connect(params: ConnectParams): Promise<ConnectResult> {
    // Resolve slug, command/url, and transport type
    let slug: string;
    let command: string | undefined;
    let args: string[] | undefined;
    let url: string | undefined;
    let displayName: string;
    let trustTier: TrustTier = "unknown";
    let transportType: TransportType = params.transportType || "stdio";
    // Retained for sandbox manifest resolution (declared auth env vars, etc.)
    let registryServer: RegistryServer | null = null;

    if (params.url) {
      // URL-based connection (SSE, WebSocket, Streamable HTTP)
      url = params.url;
      slug = params.slug || this.slugFromUrl(url);
      displayName = params.slug || slug;

      // Auto-detect transport type from URL scheme if not specified
      if (!params.transportType) {
        if (url.startsWith("ws://") || url.startsWith("wss://")) {
          transportType = "websocket";
        } else if (url.includes("/sse")) {
          transportType = "sse";
        } else {
          transportType = "streamable-http";
        }
      }

      // Try to get trust info from registry if slug looks like a registry slug
      if (params.slug) {
        try {
          const server = await this.registryClient.getServer(params.slug);
          if (server) {
            registryServer = server;
            displayName = server.name || slug;
            trustTier = (
              await import("../registry/registry-client.js")
            ).RegistryClient.determineTrustTier(server);
          }
        } catch {
          // Not in registry — that's fine for URL-based connections
        }
      }
    } else if (params.slug) {
      // Registry-based connection
      slug = params.slug;
      const server = await this.registryClient.getServer(slug);

      if (!server) {
        throw new ConnectionError(
          `Server "${slug}" not found in MCP-Rating registry.`,
          slug,
        );
      }

      registryServer = server;
      displayName = server.name || slug;

      // Determine trust
      trustTier = (
        await import("../registry/registry-client.js")
      ).RegistryClient.determineTrustTier(server);

      // Resolve install command
      const install = this.registryClient.resolveInstallCommand(server);
      if (!install) {
        throw new ConnectionError(
          `No install command available for "${slug}". Try providing explicit command and args.`,
          slug,
        );
      }
      command = install.command;
      args = install.args;
    } else if (params.command) {
      // Explicit command-based connection (stdio)
      command = params.command;
      args = params.args || [];
      slug = params.command + (args.length > 0 ? `-${args[args.length - 1]}` : "");
      // Sanitize slug: remove @ / . characters, replace with dashes
      slug = slug.replace(/[@/.]/g, "-").replace(/--+/g, "-").replace(/^-|-$/g, "");
      displayName = slug;
    } else {
      throw new ConnectionError(
        "Either 'slug', 'command', or 'url' must be provided.",
        "unknown",
      );
    }

    // Check trust policy — require confirmation for community/unknown tier
    const policy = getTrustPolicy(trustTier);
    if (!policy.allowByDefault) {
      throw new PermissionDeniedError(slug, `Connection to "${slug}" is blocked by trust policy (${trustTier}).`);
    }
    if (policy.requiresConfirmation && !params.confirmed) {
      log.info("Connection requires user confirmation", { slug, trustTier });
      const confirmation: ConfirmationRequired = {
        needsConfirmation: true,
        slug,
        displayName,
        trustTier,
        warning: `⚠️ **${displayName}** has trust tier [${trustTier}]. ${policy.description}\n\nTo proceed, call \`mcp_connect\` again with \`confirmed: true\`.`,
      };
      return confirmation;
    }

    // Check for duplicate connections (but allow reconnecting failed connections)
    const existing = this.connections.get(slug);
    if (existing && existing.state !== "failed") {
      throw new DuplicateConnectionError(slug);
    }

    // Clean up failed connection if re-connecting
    if (existing?.state === "failed") {
      this.connections.delete(slug);
    }

    // Check max connections
    if (this.connections.size >= this.config.maxConnections) {
      throw new MaxConnectionsError(this.config.maxConnections);
    }

    // Create a placeholder connection entry (state: connecting)
    const connection: DownstreamConnection = {
      slug,
      displayName,
      state: "connecting",
      client: null!,
      transport: null!,
      transportType,
      tools: new Map(),
      resources: new Map(),
      prompts: new Map(),
      registeredProxies: new Map(),
      registeredResourceProxies: new Map(),
      registeredPromptProxies: new Map(),
      connectedAt: new Date(),
      trustTier,
      originalParams: { ...params, slug: params.slug || slug },
      reconnectAttempts: 0,
      failedPings: 0,
    };
    this.connections.set(slug, connection);

    try {
      let finalCommand = command;
      let finalArgs = args;
      let preScopedEnv: Record<string, string> | undefined;

      // Sandbox: resolve the capability manifest for stdio servers up front so
      // we know the enforcement level before deciding how to spawn.
      let manifest: CapabilityManifest | undefined;
      if (transportType === "stdio" && this.manifestResolver) {
        manifest = this.manifestResolver.resolve(
          slug,
          trustTier,
          registryServer,
          params.env ? Object.keys(params.env) : [],
        );
      }

      // Decide whether to run inside a container (L2). Requires an available
      // engine; otherwise we transparently downgrade to L1 process scoping.
      let useContainer = false;
      if (manifest?.enforcement === "l2-container" && command) {
        const engine = await detectContainerEngine();
        if (engine) {
          useContainer = true;

          // For network:allowlist, start an egress proxy and route the
          // container's HTTP(S) traffic through it for host filtering.
          let egressProxyUrl: string | undefined;
          if (manifest.network.mode === "allowlist") {
            const proxy = new EgressProxy(manifest.network.allow, slug, this.auditLog);
            await proxy.start();
            connection.egressProxy = proxy;
            egressProxyUrl = proxy.containerProxyUrl;
          }

          // Prefer a pre-baked image if one exists — it runs offline, so
          // network:none works without an npx/uvx fetch at runtime.
          const bakedImage = (await resolveBakedImage(engine, slug)) ?? undefined;

          const wrapped = buildContainerCommand(engine, manifest, command, args || [], {
            egressProxyUrl,
            bakedImage,
          });
          finalCommand = wrapped.command;
          finalArgs = wrapped.args;
          log.info("Applied L2 container isolation", {
            slug,
            engine,
            network: manifest.network.mode,
            egressFiltered: Boolean(egressProxyUrl),
          });
        } else {
          // No engine — downgrade to L1 and record it on the manifest.
          manifest = { ...manifest, enforcement: "l1-process" };
          log.warn("Container isolation requested but no engine available; using L1", { slug });
        }
      }

      // Auto-install on the HOST only when not containerized (the container
      // resolves the package itself via npx/uvx inside the sandbox).
      if (
        !useContainer &&
        transportType === "stdio" &&
        command &&
        this.config.enableAutoInstall !== false
      ) {
        const installed = await ensureInstalled(command, args || []);
        finalCommand = installed.command;
        finalArgs = installed.args;
      }

      // Sandbox L1: build the scoped environment. Only manifest-allowed env
      // vars (declared auth + user-supplied) plus safe defaults reach the
      // child — the rest of process.env is withheld. For L2, the docker CLI
      // process receives this env and `-e NAME` forwards the allowed vars in.
      if (manifest) {
        preScopedEnv = buildScopedEnvironment(manifest.env, params.env);
        connection.manifest = manifest;
        log.info("Applied sandbox env scoping", {
          slug,
          enforcement: manifest.enforcement,
          allowedEnvCount: Object.keys(preScopedEnv).length,
        });
      }

      // Connect via the appropriate transport
      const result = await createTransport({
        slug,
        transportType,
        command: finalCommand,
        args: finalArgs,
        env: params.env,
        preScopedEnv,
        url,
        onClose: () => this.handleProcessCrash(slug),
        onToolsChanged: () => this.handleToolsChanged(slug),
        connectionTimeoutMs: this.config.proxyTimeoutMs,
      });

      // Update connection with real data
      connection.client = result.client;
      connection.transport = result.transport;
      connection.serverInfo = result.serverInfo;
      connection.state = "ready";

      // Store downstream tools
      for (const tool of result.tools) {
        connection.tools.set(tool.name, tool);
      }

      // Store downstream resources
      for (const resource of result.resources) {
        connection.resources.set(resource.uri, resource);
      }

      // Store downstream prompts
      for (const prompt of result.prompts) {
        connection.prompts.set(prompt.name, prompt);
      }

      // Register proxied tools on the gateway (with optional permission filtering)
      connection.registeredProxies = registerProxiedTools(
        this.mcpServer,
        connection,
        result.tools,
        this.config.proxyTimeoutMs,
        this.permissionManager,
        this.adTracker,
        this.usageTracker,
        this.pluginManager,
        this.auditLog,
      );

      // Register proxied resources on the gateway
      if (result.resources.length > 0) {
        connection.registeredResourceProxies = registerProxiedResources(
          this.mcpServer,
          connection,
          result.resources,
        );
      }

      // Register proxied prompts on the gateway
      if (result.prompts.length > 0) {
        connection.registeredPromptProxies = registerProxiedPrompts(
          this.mcpServer,
          connection,
          result.prompts,
        );
      }

      // Notify host client that tool list changed
      this.mcpServer.sendToolListChanged();
      if (result.resources.length > 0) {
        this.mcpServer.sendResourceListChanged();
      }
      if (result.prompts.length > 0) {
        this.mcpServer.sendPromptListChanged();
      }

      // Save profile if requested
      if (params.saveProfile) {
        addProfile(this.config.profilesPath, {
          slug: params.slug,
          command: params.command,
          args: params.args,
          env: params.env,
          confirmed: true,
          transportType: params.transportType,
          url: params.url,
        });
        log.info("Saved connection profile", { slug });
      }

      // Track connect event for ad attribution (fire-and-forget)
      if (this.adTracker) {
        this.adTracker.trackConnect(slug).catch(() => {});
      }

      // Run plugin onConnect hooks
      if (this.pluginManager) {
        const summary = this.toSummary(connection);
        this.pluginManager.runOnConnect(summary).catch(() => {});
      }

      // Safety audit: record the connect + the capability envelope granted.
      this.auditLog?.record({
        type: "connect",
        slug,
        enforcement: connection.manifest?.enforcement ?? "none",
        reason: connection.manifest
          ? `env:[${connection.manifest.env.allow.join(",")}] net:${connection.manifest.network.mode}`
          : undefined,
      });

      log.info("Server connected successfully", {
        slug,
        displayName,
        trustTier,
        transportType,
        toolCount: result.tools.length,
        resourceCount: result.resources.length,
        promptCount: result.prompts.length,
      });

      return this.toSummary(connection);
    } catch (err) {
      // Cleanup on failure
      this.connections.delete(slug);
      const msg = err instanceof Error ? err.message : String(err);
      throw new ConnectionError(
        `Failed to connect to "${slug}": ${msg}`,
        slug,
      );
    }
  }

  /**
   * Disconnect from a downstream server.
   */
  async disconnect(slug: string, options?: { removeProfile?: boolean }): Promise<void> {
    const connection = this.connections.get(slug);
    if (!connection) {
      throw new ConnectionError(`Server "${slug}" is not connected.`, slug);
    }

    connection.state = "disconnecting";
    log.info("Disconnecting server", { slug });

    // Cancel any pending reconnect
    this.cancelReconnect(slug);

    // Cancel any pending re-sync
    const pendingResync = this.resyncTimers.get(slug);
    if (pendingResync) {
      clearTimeout(pendingResync);
      this.resyncTimers.delete(slug);
    }

    // Remove proxied tools, resources, and prompts
    removeProxiedTools(connection.registeredProxies);
    removeProxiedResources(connection.registeredResourceProxies);
    removeProxiedPrompts(connection.registeredPromptProxies);

    // Close MCP client connection
    try {
      if (connection.transport) {
        await connection.transport.close();
      }
    } catch (err) {
      log.warn("Error closing transport", {
        slug,
        error: String(err),
      });
    }

    // Stop the egress allowlist proxy if one was started for this connection.
    if (connection.egressProxy) {
      await connection.egressProxy.stop().catch(() => {});
      connection.egressProxy = undefined;
    }

    this.connections.delete(slug);

    // Remove auto-connect profile if requested
    if (options?.removeProfile !== false) {
      removeProfile(this.config.profilesPath, slug);
    }

    // Notify host client
    this.mcpServer.sendToolListChanged();
    if (connection.resources.size > 0) {
      this.mcpServer.sendResourceListChanged();
    }
    if (connection.prompts.size > 0) {
      this.mcpServer.sendPromptListChanged();
    }

    // Run plugin onDisconnect hooks
    if (this.pluginManager) {
      this.pluginManager.runOnDisconnect(slug).catch(() => {});
    }

    this.auditLog?.record({ type: "disconnect", slug });

    log.info("Server disconnected", { slug });
  }

  /**
   * Disconnect all downstream servers (for graceful shutdown).
   */
  async disconnectAll(): Promise<void> {
    this.stopHealthChecks();

    // Cancel all pending reconnects
    for (const [slug, timer] of this.reconnectTimers) {
      clearTimeout(timer);
      this.reconnectTimers.delete(slug);
    }

    const slugs = [...this.connections.keys()];
    log.info("Disconnecting all servers", { count: slugs.length });

    for (const slug of slugs) {
      try {
        await this.disconnect(slug, { removeProfile: false });
      } catch (err) {
        log.warn("Error during disconnect", {
          slug,
          error: String(err),
        });
      }
    }
  }

  getConnection(slug: string): DownstreamConnection | undefined {
    return this.connections.get(slug);
  }

  listConnections(): ConnectionSummary[] {
    return [...this.connections.values()].map((c) => this.toSummary(c));
  }

  get connectionCount(): number {
    return this.connections.size;
  }

  // ── Auto-connect from saved profiles ──────────────────────────

  /**
   * Load saved connection profiles and auto-connect each one.
   * Called once during gateway startup.
   */
  async autoConnectFromProfiles(): Promise<void> {
    const store = loadProfiles(this.config.profilesPath);
    if (store.connections.length === 0) return;

    log.info("Auto-connecting from saved profiles", {
      count: store.connections.length,
    });

    for (const profile of store.connections) {
      try {
        await this.connect({ ...profile, confirmed: true });
      } catch (err) {
        log.warn("Auto-connect failed for profile", {
          slug: profile.slug || profile.command,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  // ── Health monitoring ─────────────────────────────────────────

  /**
   * Start periodic health checks on all ready connections.
   */
  startHealthChecks(): void {
    if (this.healthCheckInterval) return;

    this.healthCheckInterval = setInterval(() => {
      this.runHealthChecks().catch((err) => {
        log.error("Health check cycle failed", { error: String(err) });
      });
    }, this.config.healthCheckIntervalMs);

    log.info("Health checks started", {
      intervalMs: this.config.healthCheckIntervalMs,
    });
  }

  /**
   * Stop the health check interval.
   */
  stopHealthChecks(): void {
    if (this.healthCheckInterval) {
      clearInterval(this.healthCheckInterval);
      this.healthCheckInterval = null;
      log.info("Health checks stopped");
    }
  }

  private async runHealthChecks(): Promise<void> {
    const readyConnections = [...this.connections.values()].filter(
      (c) => c.state === "ready",
    );

    for (const connection of readyConnections) {
      try {
        await connection.client.ping({ signal: AbortSignal.timeout(5_000) });
        connection.failedPings = 0;
        connection.lastPingAt = new Date();
        log.debug("Health check passed", { slug: connection.slug });
      } catch (err) {
        connection.failedPings++;
        log.warn("Health check failed", {
          slug: connection.slug,
          failedPings: connection.failedPings,
          error: String(err),
        });

        if (connection.failedPings >= 3) {
          log.warn("Too many failed pings, treating as crash", {
            slug: connection.slug,
          });
          this.handleProcessCrash(connection.slug);
        }
      }
    }
  }

  // ── Crash handling + auto-reconnect ────────────────────────────

  /**
   * Handle a downstream process crash.
   * Removes proxied tools/resources/prompts and attempts auto-reconnect.
   */
  private handleProcessCrash(slug: string): void {
    const connection = this.connections.get(slug);
    if (!connection || connection.state === "disconnecting") return;

    log.warn("Downstream server process crashed", { slug });

    // Cancel any pending re-sync
    const pendingResync = this.resyncTimers.get(slug);
    if (pendingResync) {
      clearTimeout(pendingResync);
      this.resyncTimers.delete(slug);
    }

    // Remove proxied tools, resources, and prompts
    removeProxiedTools(connection.registeredProxies);
    removeProxiedResources(connection.registeredResourceProxies);
    removeProxiedPrompts(connection.registeredPromptProxies);
    connection.registeredProxies = new Map();
    connection.registeredResourceProxies = new Map();
    connection.registeredPromptProxies = new Map();
    connection.tools.clear();
    connection.resources.clear();
    connection.prompts.clear();

    // Notify host client that tools were removed
    this.mcpServer.sendToolListChanged();

    // Attempt reconnect if we have the original params
    if (connection.originalParams) {
      connection.state = "reconnecting";
      connection.lastError = "Process exited unexpectedly";
      this.scheduleReconnect(slug);
    } else {
      connection.state = "failed";
      connection.lastError = "Process exited unexpectedly (no reconnect params)";
      log.error("Cannot auto-reconnect — no original params stored", { slug });
    }
  }

  private scheduleReconnect(slug: string): void {
    const connection = this.connections.get(slug);
    if (!connection || connection.state !== "reconnecting") return;

    const maxAttempts = this.config.reconnectMaxAttempts;
    if (connection.reconnectAttempts >= maxAttempts) {
      connection.state = "failed";
      connection.lastError = `All ${maxAttempts} reconnect attempts exhausted`;
      log.error("Reconnect attempts exhausted", { slug, maxAttempts });
      return;
    }

    // Exponential backoff: base * 2^attempt, capped at 30s
    const delay = Math.min(
      this.config.reconnectBaseDelayMs * Math.pow(2, connection.reconnectAttempts),
      30_000,
    );
    connection.reconnectAttempts++;

    log.info("Scheduling reconnect", {
      slug,
      attempt: connection.reconnectAttempts,
      maxAttempts,
      delayMs: delay,
    });

    const timer = setTimeout(() => {
      this.reconnectTimers.delete(slug);
      this.attemptReconnect(slug).catch((err) => {
        log.error("Reconnect attempt failed", {
          slug,
          error: String(err),
        });
      });
    }, delay);

    this.reconnectTimers.set(slug, timer);
  }

  private async attemptReconnect(slug: string): Promise<void> {
    const connection = this.connections.get(slug);
    if (!connection || connection.state !== "reconnecting") return;
    if (!connection.originalParams) return;

    const params = connection.originalParams;
    const transportType = params.transportType || connection.transportType || "stdio";

    log.info("Attempting reconnect", {
      slug,
      attempt: connection.reconnectAttempts,
      transportType,
    });

    try {
      const result = await createTransport({
        slug,
        transportType,
        command: params.command || "npx",
        args: params.args || [],
        env: params.env,
        url: params.url,
        onClose: () => this.handleProcessCrash(slug),
        onToolsChanged: () => this.handleToolsChanged(slug),
        connectionTimeoutMs: this.config.proxyTimeoutMs,
      });

      // Reconnect succeeded
      connection.client = result.client;
      connection.transport = result.transport;
      connection.serverInfo = result.serverInfo;
      connection.state = "ready";
      connection.reconnectAttempts = 0;
      connection.failedPings = 0;
      connection.lastError = undefined;
      connection.connectedAt = new Date();

      // Re-register tools
      for (const tool of result.tools) {
        connection.tools.set(tool.name, tool);
      }
      connection.registeredProxies = registerProxiedTools(
        this.mcpServer,
        connection,
        result.tools,
        this.config.proxyTimeoutMs,
        this.permissionManager,
        this.adTracker,
        this.usageTracker,
        this.pluginManager,
        this.auditLog,
      );

      // Re-register resources
      for (const resource of result.resources) {
        connection.resources.set(resource.uri, resource);
      }
      if (result.resources.length > 0) {
        connection.registeredResourceProxies = registerProxiedResources(
          this.mcpServer,
          connection,
          result.resources,
        );
      }

      // Re-register prompts
      for (const prompt of result.prompts) {
        connection.prompts.set(prompt.name, prompt);
      }
      if (result.prompts.length > 0) {
        connection.registeredPromptProxies = registerProxiedPrompts(
          this.mcpServer,
          connection,
          result.prompts,
        );
      }

      this.mcpServer.sendToolListChanged();

      log.info("Reconnect succeeded", {
        slug,
        toolCount: result.tools.length,
        resourceCount: result.resources.length,
        promptCount: result.prompts.length,
      });
    } catch (err) {
      log.warn("Reconnect attempt failed", {
        slug,
        attempt: connection.reconnectAttempts,
        error: err instanceof Error ? err.message : String(err),
      });
      // Schedule next attempt
      this.scheduleReconnect(slug);
    }
  }

  private cancelReconnect(slug: string): void {
    const timer = this.reconnectTimers.get(slug);
    if (timer) {
      clearTimeout(timer);
      this.reconnectTimers.delete(slug);
    }
  }

  // ── Tool list changes ─────────────────────────────────────────

  /**
   * Handle a downstream server's tool list changing.
   * Debounced to 500ms to prevent notification spam from chatty servers.
   */
  private handleToolsChanged(slug: string): void {
    // Clear any pending re-sync for this slug
    const existing = this.resyncTimers.get(slug);
    if (existing) clearTimeout(existing);

    // Schedule a debounced re-sync
    const timer = setTimeout(() => {
      this.resyncTimers.delete(slug);
      this.doCapabilityResync(slug).catch((err) => {
        log.error("Failed to re-sync capabilities", {
          slug,
          error: String(err),
        });
      });
    }, 500);

    this.resyncTimers.set(slug, timer);
  }

  /**
   * Re-sync all proxied capabilities (tools, resources, prompts) for a downstream connection.
   */
  private async doCapabilityResync(slug: string): Promise<void> {
    const connection = this.connections.get(slug);
    if (!connection || connection.state !== "ready") return;

    log.info("Re-syncing capabilities for server", { slug });

    // Fetch updated tool list
    const response = await connection.client.listTools();
    const newTools: DownstreamTool[] = response.tools.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema as Record<string, unknown>,
      annotations: t.annotations as Record<string, unknown> | undefined,
      execution: (t as { execution?: { taskSupport?: "optional" | "required" | "forbidden" } })
        .execution,
    }));

    // Remove old proxied tools
    removeProxiedTools(connection.registeredProxies);

    // Update stored tools
    connection.tools.clear();
    for (const tool of newTools) {
      connection.tools.set(tool.name, tool);
    }

    // Register new proxied tools (with optional permission filtering)
    connection.registeredProxies = registerProxiedTools(
      this.mcpServer,
      connection,
      newTools,
      this.config.proxyTimeoutMs,
      this.permissionManager,
      this.adTracker,
      this.usageTracker,
      this.pluginManager,
      this.auditLog,
    );

    // Re-sync resources
    try {
      const resourcesResponse = await connection.client.listResources();
      const newResources: DownstreamResource[] = resourcesResponse.resources.map((r) => ({
        uri: r.uri,
        name: r.name,
        description: r.description,
        mimeType: r.mimeType,
      }));

      removeProxiedResources(connection.registeredResourceProxies);
      connection.resources.clear();
      for (const resource of newResources) {
        connection.resources.set(resource.uri, resource);
      }
      if (newResources.length > 0) {
        connection.registeredResourceProxies = registerProxiedResources(
          this.mcpServer,
          connection,
          newResources,
        );
        this.mcpServer.sendResourceListChanged();
      }
    } catch {
      // Server doesn't support resources — that's fine
    }

    // Re-sync prompts
    try {
      const promptsResponse = await connection.client.listPrompts();
      const newPrompts: DownstreamPrompt[] = promptsResponse.prompts.map((p) => ({
        name: p.name,
        description: p.description,
        arguments: p.arguments?.map((a) => ({
          name: a.name,
          description: a.description,
          required: a.required,
        })),
      }));

      removeProxiedPrompts(connection.registeredPromptProxies);
      connection.prompts.clear();
      for (const prompt of newPrompts) {
        connection.prompts.set(prompt.name, prompt);
      }
      if (newPrompts.length > 0) {
        connection.registeredPromptProxies = registerProxiedPrompts(
          this.mcpServer,
          connection,
          newPrompts,
        );
        this.mcpServer.sendPromptListChanged();
      }
    } catch {
      // Server doesn't support prompts — that's fine
    }

    // Notify host client
    this.mcpServer.sendToolListChanged();

    log.info("Capability re-sync complete", {
      slug,
      toolCount: newTools.length,
      resourceCount: connection.resources.size,
      promptCount: connection.prompts.size,
    });
  }

  // ── Helpers ────────────────────────────────────────────────────

  private toSummary(connection: DownstreamConnection): ConnectionSummary {
    return {
      slug: connection.slug,
      displayName: connection.displayName,
      state: connection.state,
      trustTier: connection.trustTier,
      transportType: connection.transportType,
      toolCount: connection.tools.size,
      resourceCount: connection.resources.size,
      promptCount: connection.prompts.size,
      connectedAt: connection.connectedAt,
      serverInfo: connection.serverInfo,
      reconnectAttempts: connection.reconnectAttempts || undefined,
      failedPings: connection.failedPings || undefined,
      lastPingAt: connection.lastPingAt,
    };
  }

  /** Derive a slug from a URL */
  private slugFromUrl(url: string): string {
    try {
      const parsed = new URL(url);
      return parsed.hostname.replace(/\./g, "-") + (parsed.port ? `-${parsed.port}` : "");
    } catch {
      return url.replace(/[^a-zA-Z0-9]/g, "-").replace(/--+/g, "-").replace(/^-|-$/g, "");
    }
  }
}
