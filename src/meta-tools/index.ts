import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ConnectionManager } from "../connection/connection-manager.js";
import type { RegistryClient } from "../registry/registry-client.js";
import type { AdTracker } from "../ads/ad-tracker.js";
import type { UsageTracker } from "../analytics/usage-tracker.js";
import type { AutoRecommender } from "../discovery/auto-recommender.js";
import { registerDiscover } from "./discover.js";
import { registerConnect } from "./connect.js";
import { registerDisconnect } from "./disconnect.js";
import { registerListActive } from "./list-active.js";
import { registerServerInfo } from "./server-info.js";
import { registerCallTool } from "./call-tool.js";
import { registerHealth } from "./health.js";
import { registerAdStatus } from "./ad-status.js";
import { registerProfiles } from "./profiles.js";
import { registerGroups } from "./groups.js";
import { registerUsage } from "./usage.js";
import { registerRecommend } from "./recommend.js";
import { registerSandbox } from "./sandbox.js";
import { registerAudit } from "./audit.js";
import type { AuditLog } from "../audit/audit-log.js";

export interface MetaToolOptions {
  /** Ad tracker for ad-related meta-tool */
  adTracker?: AdTracker | null;
  /** Usage tracker for analytics meta-tool */
  usageTracker?: UsageTracker | null;
  /** Auto-recommender for recommendation meta-tool */
  autoRecommender?: AutoRecommender | null;
  /** Path to profiles file (for profiles meta-tool) */
  profilesPath?: string;
  /** Path to groups file (for groups meta-tool) */
  groupsPath?: string;
  /** Safety audit log (for the audit forensics meta-tool) */
  auditLog?: AuditLog | null;
}

/**
 * Register all gateway meta-tools on the MCP server.
 *
 * These are the tools users interact with to discover, connect,
 * and manage downstream MCP servers.
 */
export function registerMetaTools(
  server: McpServer,
  connectionManager: ConnectionManager,
  registryClient: RegistryClient,
  options: MetaToolOptions = {},
): void {
  // Core meta-tools
  registerDiscover(server, registryClient);
  registerConnect(server, connectionManager);
  registerDisconnect(server, connectionManager);
  registerListActive(server, connectionManager);
  registerServerInfo(server, connectionManager, registryClient);
  registerCallTool(server, connectionManager);
  registerHealth(server, connectionManager, registryClient);
  registerSandbox(server, connectionManager);

  // Safety audit forensics meta-tool
  if (options.auditLog) {
    registerAudit(server, options.auditLog);
  }

  // Ad tracking meta-tool (if partner key configured)
  if (options.adTracker) {
    registerAdStatus(server, connectionManager, options.adTracker);
  }

  // Profile management meta-tool
  if (options.profilesPath) {
    registerProfiles(server, connectionManager, options.profilesPath);
  }

  // Group management meta-tool
  if (options.groupsPath) {
    registerGroups(server, connectionManager, options.groupsPath);
  }

  // Usage analytics meta-tool
  if (options.usageTracker) {
    registerUsage(server, options.usageTracker);
  }

  // Auto-recommendation meta-tool
  if (options.usageTracker && options.autoRecommender) {
    registerRecommend(server, options.autoRecommender, options.usageTracker);
  }
}
