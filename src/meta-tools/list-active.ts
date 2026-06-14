import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ConnectionManager } from "../connection/connection-manager.js";
import { TRUST_LABELS } from "../permissions/trust-tiers.js";

export function registerListActive(
  server: McpServer,
  connectionManager: ConnectionManager,
): void {
  server.tool(
    "mcp_list_active",
    "List all currently connected MCP servers and their tools.",
    {},
    async () => {
      const connections = connectionManager.listConnections();

      if (connections.length === 0) {
        return {
          content: [
            {
              type: "text" as const,
              text: "No MCP servers are currently connected.\n\nUse `mcp_discover` to find servers, then `mcp_connect` to connect.",
            },
          ],
        };
      }

      const lines: string[] = [
        `## Active MCP Connections (${connections.length})`,
        "",
      ];

      for (const conn of connections) {
        const tierLabel = TRUST_LABELS[conn.trustTier];
        const duration = formatDuration(
          Date.now() - conn.connectedAt.getTime(),
        );
        const serverVer = conn.serverInfo
          ? `${conn.serverInfo.name} v${conn.serverInfo.version}`
          : "unknown";

        lines.push(
          `### ${conn.displayName}`,
          `**Slug:** \`${conn.slug}\` · **Trust:** [${tierLabel}] · **State:** ${conn.state}`,
          `**Server:** ${serverVer} · **Tools:** ${conn.toolCount} · **Connected:** ${duration}`,
        );
        if (conn.state === "reconnecting" && conn.reconnectAttempts) {
          lines.push(`⚠️ Reconnecting (attempt ${conn.reconnectAttempts})...`);
        }
        if (conn.state === "failed") {
          lines.push(`❌ Connection failed — use \`mcp_connect\` to retry manually.`);
        }
        lines.push("");
      }

      lines.push(
        "---",
        `Use \`mcp_disconnect({slug: "..."})\` to disconnect a server.`,
      );

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
  return `${hours}h ${minutes % 60}m`;
}
