import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ConnectionManager } from "../connection/connection-manager.js";
import type { AdTracker } from "../ads/ad-tracker.js";

/**
 * Register the mcp_ad_status meta-tool.
 * Shows partner earnings, tracked events, and which connected servers are promoted.
 */
export function registerAdStatus(
  server: McpServer,
  connectionManager: ConnectionManager,
  adTracker: AdTracker,
): void {
  server.tool(
    "mcp_ad_status",
    "View partner ad earnings, tracked events (connects, tool usage), and ad network status for this gateway session.",
    {},
    async () => {
      const status = adTracker.getStatus();
      const earnings = await adTracker.getPartnerEarnings();
      const connections = connectionManager.listConnections();

      const lines: string[] = [
        "## Ad Network Status",
        "",
        `**Session ID:** ${status.sessionId}`,
        `**Partner Key:** Configured`,
        "",
        "### Event Tracking",
        `- **Connect events:** ${status.eventCounts.connect}`,
        `- **Tool usage events:** ${status.eventCounts.tool_usage}`,
        `- **Total tracked:** ${status.totalEvents}`,
        "",
      ];

      if (earnings) {
        lines.push(
          "### Partner Earnings",
          `- **Total gross:** $${(earnings.totalGrossCents / 100).toFixed(2)}`,
          `- **Your share:** $${(earnings.totalPartnerShareCents / 100).toFixed(2)}`,
          `- **Revenue events:** ${earnings.eventCount}`,
          "",
        );
      } else {
        lines.push(
          "### Partner Earnings",
          "*Unable to fetch earnings from registry.*",
          "",
        );
      }

      // Show connected servers
      if (connections.length > 0) {
        lines.push(
          "### Connected Servers",
          ...connections.map(
            (c) => `- **${c.displayName}** (\`${c.slug}\`) — ${c.state}`,
          ),
          "",
        );
      }

      // Show recent events
      if (status.recentEvents.length > 0) {
        lines.push(
          "### Recent Events (last 10)",
          ...status.recentEvents.map(
            (e) =>
              `- \`${e.eventType}\` on **${e.serverSlug}**${e.toolName ? ` (tool: ${e.toolName})` : ""} at ${e.timestamp}`,
          ),
        );
      }

      return {
        content: [{ type: "text", text: lines.join("\n") }],
      };
    },
  );
}
