import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ConnectionManager } from "../connection/connection-manager.js";
import type { RegistryClient } from "../registry/registry-client.js";
import { TRUST_LABELS } from "../permissions/trust-tiers.js";

const GATEWAY_VERSION = "0.1.0";

export function registerHealth(
  server: McpServer,
  connectionManager: ConnectionManager,
  registryClient: RegistryClient,
): void {
  server.tool(
    "mcp_gateway_health",
    "Get gateway diagnostics: version, uptime, connection status, registry reachability, and per-server health.",
    {},
    async () => {
      const connections = connectionManager.listConnections();
      const registryStatus = registryClient.getStatus();
      const uptimeMs = Date.now() - connectionManager.startedAt.getTime();

      const lines: string[] = [
        `## MCP Gateway Health`,
        "",
        `**Version:** ${GATEWAY_VERSION}`,
        `**Uptime:** ${formatDuration(uptimeMs)}`,
        `**Connections:** ${connections.length}`,
        "",
      ];

      // Registry status
      lines.push("### Registry");
      if (registryStatus.lastSuccessfulCall) {
        const ago = formatDuration(
          Date.now() - registryStatus.lastSuccessfulCall.getTime(),
        );
        lines.push(`**Status:** Reachable (last success ${ago} ago)`);
      } else if (registryStatus.lastError) {
        lines.push(`**Status:** Unreachable`);
        lines.push(`**Last Error:** ${registryStatus.lastError}`);
      } else {
        lines.push(`**Status:** No calls made yet`);
      }
      lines.push(`**Cache Entries:** ${registryStatus.cacheSize}`, "");

      // Per-connection details
      if (connections.length > 0) {
        lines.push("### Connections", "");
        for (const conn of connections) {
          const tierLabel = TRUST_LABELS[conn.trustTier];
          const duration = formatDuration(
            Date.now() - conn.connectedAt.getTime(),
          );
          const serverVer = conn.serverInfo
            ? `${conn.serverInfo.name} v${conn.serverInfo.version}`
            : "unknown";

          lines.push(`**${conn.displayName}** (\`${conn.slug}\`)`);
          lines.push(
            `  State: ${conn.state} · Trust: [${tierLabel}] · Tools: ${conn.toolCount}`,
          );
          lines.push(`  Server: ${serverVer} · Connected: ${duration}`);

          if (conn.reconnectAttempts && conn.reconnectAttempts > 0) {
            lines.push(`  Reconnect attempts: ${conn.reconnectAttempts}`);
          }
          if (conn.failedPings && conn.failedPings > 0) {
            lines.push(`  Failed pings: ${conn.failedPings}`);
          }
          if (conn.lastPingAt) {
            const pingAgo = formatDuration(
              Date.now() - conn.lastPingAt.getTime(),
            );
            lines.push(`  Last ping: ${pingAgo} ago`);
          }
          lines.push("");
        }
      } else {
        lines.push("### Connections", "", "No servers connected.", "");
      }

      return {
        content: [{ type: "text" as const, text: lines.join("\n") }],
      };
    },
  );
}

function formatDuration(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ${minutes % 60}m`;
  const days = Math.floor(hours / 24);
  return `${days}d ${hours % 24}h`;
}
