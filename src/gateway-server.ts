import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  InMemoryTaskStore,
  InMemoryTaskMessageQueue,
} from "@modelcontextprotocol/sdk/experimental/tasks/stores/in-memory.js";
import type { GatewayConfig } from "./config/types.js";
import { RegistryClient } from "./registry/registry-client.js";
import { ConnectionManager } from "./connection/connection-manager.js";
import { PermissionManager } from "./permissions/permission-manager.js";
import { registerMetaTools } from "./meta-tools/index.js";
import { AdTracker } from "./ads/ad-tracker.js";
import { UsageTracker } from "./analytics/usage-tracker.js";
import { PluginManager } from "./plugins/plugin-manager.js";
import { loggingPlugin } from "./plugins/builtin/logging-plugin.js";
import { AutoRecommender } from "./discovery/auto-recommender.js";
import { ManifestResolver } from "./sandbox/manifest-resolver.js";
import { AuditLog } from "./audit/audit-log.js";
import { primeProxyHandlers } from "./proxy/prime-handlers.js";
import { dirname, join } from "node:path";

const GATEWAY_VERSION = "0.2.0";

export interface GatewayContext {
  mcpServer: McpServer;
  connectionManager: ConnectionManager;
  registryClient: RegistryClient;
  permissionManager: PermissionManager;
  adTracker: AdTracker | null;
  usageTracker: UsageTracker | null;
  pluginManager: PluginManager;
  autoRecommender: AutoRecommender | null;
  auditLog: AuditLog;
}

/**
 * Process-wide singletons that can be shared across multiple gateway contexts
 * (e.g. one per HTTP session). Sharing these gives the daemon a warm registry
 * cache and a single source of truth for sandbox manifests, while each session
 * still gets its own McpServer + ConnectionManager (connection isolation).
 */
export interface SharedSingletons {
  registryClient?: RegistryClient;
  manifestResolver?: ManifestResolver;
}

/**
 * Create and wire up the MCP Gateway server.
 *
 * Returns a context object containing the McpServer and all component
 * managers. The caller is responsible for connecting a transport and
 * handling shutdown via `connectionManager.disconnectAll()`.
 *
 * @param shared Optional process-wide singletons to reuse across contexts.
 */
export function createGatewayServer(
  config: GatewayConfig,
  shared: SharedSingletons = {},
): GatewayContext {
  const mcpServer = new McpServer(
    {
      name: "mcp-gateway",
      version: GATEWAY_VERSION,
    },
    {
      capabilities: {
        tools: { listChanged: true },
        resources: { listChanged: true },
        prompts: { listChanged: true },
        // Experimental Tasks capability — must be advertised at initialize
        // so upstream clients send task-augmented `tools/call` requests.
        // `list`/`cancel` enable tasks/list and tasks/cancel; `requests.tools.call`
        // enables task creation for tool calls.
        tasks: {
          list: {},
          cancel: {},
          requests: { tools: { call: {} } },
        },
      },
      // The in-memory store mirrors downstream task state; the message
      // queue buffers side-channel messages during task execution.
      taskStore: new InMemoryTaskStore(),
      taskMessageQueue: new InMemoryTaskMessageQueue(),
      instructions: [
        "MCP Gateway — a meta-server that discovers, connects, and proxies other MCP servers.",
        "",
        "Use mcp_discover to search the MCP-Rating registry for servers.",
        "Use mcp_connect to connect to a server (spawns it and proxies its tools, resources, and prompts).",
        "  - Connect via stdio: mcp_connect({command: 'npx', args: ['-y', 'package']})",
        "  - Connect via URL:   mcp_connect({url: 'http://localhost:3000/mcp'})",
        "  - Connect via slug:  mcp_connect({slug: 'server-name'})",
        "Once connected, call the server's tools directly via namespaced names like 'servername__toolname'.",
        "Use mcp_list_active to see all connected servers.",
        "Use mcp_disconnect to remove a server.",
        "",
        "Advanced features:",
        "  - mcp_profiles: Manage named connection presets (work, personal, etc.)",
        "  - mcp_groups: Atomic connect/disconnect of server groups",
        "  - mcp_usage: View call analytics, latency, and error rates",
        "  - mcp_recommend: Get AI-powered server suggestions based on usage patterns",
        "",
        "Trust tiers: [Verified] = high quality + official, [Trusted] = good quality,",
        "[Community] = listed in registry, [Unverified] = unknown origin.",
      ].join("\n"),
    },
  );

  // Reuse a shared RegistryClient (warm cache) when provided, else create one.
  const registryClient =
    shared.registryClient ??
    new RegistryClient(
      config.registryApiUrl,
      config.registryCacheTtlMs,
      config.partnerKey,
    );
  const permissionManager = new PermissionManager(config);

  // Create AdTracker if partner key is configured and tracking is not disabled
  const adTracker =
    config.partnerKey && config.enableAdTracking !== false
      ? new AdTracker(config.registryApiUrl, config.partnerKey)
      : null;

  // Create UsageTracker if analytics is enabled
  const usageTracker =
    config.enableUsageTracking !== false
      ? new UsageTracker(config.usageBufferSize)
      : null;

  // Create PluginManager and register built-in plugins
  const pluginManager = new PluginManager();
  pluginManager.register(loggingPlugin);

  // Create ConnectionManager first (AutoRecommender depends on it)
  const connectionManager = new ConnectionManager(
    mcpServer,
    registryClient,
    permissionManager,
    config,
    adTracker,
  );

  // Wire up optional components to connection manager
  connectionManager.usageTracker = usageTracker ?? undefined;
  connectionManager.pluginManager = pluginManager;

  // Safety audit trail — forensics log of sandboxed-server actions. Optional
  // durable JSONL alongside the permissions file for SIEM ingestion.
  const auditLog = new AuditLog({
    filePath: config.auditLogPath,
  });
  connectionManager.auditLog = auditLog;

  // Sandbox (L1): per-server capability manifests + env scoping.
  // Manifests are persisted alongside the permissions file. Reuse a shared
  // resolver across sessions when provided (single source of truth on disk).
  const manifestsPath = join(
    dirname(config.permissionsPath),
    "mcp-gateway-manifests.json",
  );
  connectionManager.manifestResolver =
    shared.manifestResolver ??
    new ManifestResolver(
      manifestsPath,
      config.enableContainerIsolation === true,
    );

  // Create AutoRecommender if enabled (requires connectionManager)
  const autoRecommender =
    config.enableAutoRecommend !== false
      ? new AutoRecommender(registryClient, connectionManager)
      : null;

  // Derive groups path from profiles path
  const groupsPath =
    config.groupsPath ||
    join(dirname(config.profilesPath), "mcp-gateway-groups.json");

  registerMetaTools(mcpServer, connectionManager, registryClient, {
    adTracker,
    usageTracker,
    autoRecommender,
    auditLog,
    profilesPath: config.profilesPath,
    groupsPath,
  });

  // Prime resource/prompt handlers before the transport connects, so that
  // dynamically-proxied downstream resources/prompts can be registered later
  // without hitting the SDK's post-connect capability lock.
  primeProxyHandlers(mcpServer);

  return {
    mcpServer,
    connectionManager,
    registryClient,
    permissionManager,
    adTracker,
    usageTracker,
    pluginManager,
    autoRecommender,
    auditLog,
  };
}
