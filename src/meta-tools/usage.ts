import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { UsageTracker } from "../analytics/usage-tracker.js";
import { toolError } from "../utils/errors.js";

/**
 * Register the `mcp_usage` meta-tool for viewing usage analytics.
 */
export function registerUsage(
  server: McpServer,
  usageTracker: UsageTracker,
): void {
  server.tool(
    "mcp_usage",
    "View usage analytics for connected MCP servers — call counts, latency, error rates, and recent activity.",
    {
      slug: z
        .string()
        .optional()
        .describe("Filter stats to a specific server slug. Omit for global stats."),
      action: z
        .enum(["stats", "recent", "slow", "reset"])
        .optional()
        .describe(
          "Action: stats (default — summary), recent (recent calls), slow (slow calls), reset (clear all data)",
        ),
      limit: z
        .number()
        .optional()
        .describe("Limit number of results for 'recent' and 'slow' actions (default: 20)"),
      threshold: z
        .number()
        .optional()
        .describe("Latency threshold in ms for 'slow' action (default: 5000)"),
    },
    async ({ slug, action = "stats", limit = 20, threshold = 5000 }) => {
      try {
        switch (action) {
          case "stats": {
            const stats = usageTracker.getStats(slug);

            if (stats.totalCalls === 0) {
              return {
                content: [
                  {
                    type: "text" as const,
                    text: slug
                      ? `No usage data recorded for **${slug}** yet.`
                      : "No usage data recorded yet. Start calling tools to see analytics.",
                  },
                ],
              };
            }

            const lines: string[] = [
              slug ? `## Usage Stats: ${slug}` : "## Global Usage Stats",
              "",
              `**Total calls:** ${stats.totalCalls}`,
              `**Total errors:** ${stats.totalErrors} (${((stats.totalErrors / stats.totalCalls) * 100).toFixed(1)}%)`,
              `**Avg latency:** ${stats.avgLatencyMs.toFixed(0)}ms`,
              "",
            ];

            // Top tools by calls
            if (stats.topToolsByCalls.length > 0) {
              lines.push("### Most Used Tools");
              for (const tool of stats.topToolsByCalls.slice(0, 5)) {
                const errorRate = tool.callCount > 0
                  ? ((tool.errorCount / tool.callCount) * 100).toFixed(1)
                  : "0.0";
                lines.push(
                  `- **${tool.key}**: ${tool.callCount} calls, ${tool.avgLatencyMs.toFixed(0)}ms avg, p95 ${tool.p95LatencyMs.toFixed(0)}ms, ${errorRate}% errors`,
                );
              }
              lines.push("");
            }

            // Slowest tools
            if (stats.slowestTools.length > 0) {
              lines.push("### Slowest Tools (≥5 calls)");
              for (const tool of stats.slowestTools.slice(0, 5)) {
                lines.push(
                  `- **${tool.key}**: ${tool.avgLatencyMs.toFixed(0)}ms avg, p95 ${tool.p95LatencyMs.toFixed(0)}ms (${tool.callCount} calls)`,
                );
              }
              lines.push("");
            }

            // Per-server breakdown
            if (stats.perServer.length > 0) {
              lines.push("### Per-Server Breakdown");
              for (const srv of stats.perServer) {
                const errorRate = srv.totalCalls > 0
                  ? ((srv.totalErrors / srv.totalCalls) * 100).toFixed(1)
                  : "0.0";
                lines.push(
                  `- **${srv.slug}**: ${srv.totalCalls} calls, ${srv.avgLatencyMs.toFixed(0)}ms avg, ${errorRate}% errors`,
                );
              }
              lines.push("");
            }

            return {
              content: [{ type: "text" as const, text: lines.join("\n") }],
            };
          }

          case "recent": {
            const recent = usageTracker.getRecentCalls(limit);

            if (recent.length === 0) {
              return {
                content: [
                  { type: "text" as const, text: "No recent tool calls recorded." },
                ],
              };
            }

            const lines: string[] = [
              `## Recent Tool Calls (${recent.length})`,
              "",
            ];

            for (const call of recent) {
              const status = call.success ? "✅" : "❌";
              const time = new Date(call.startedAt).toISOString().slice(11, 19);
              lines.push(
                `${status} \`${call.slug}::${call.toolName}\` — ${call.durationMs}ms [${time}]${call.error ? ` — ${call.error}` : ""}`,
              );
            }

            return {
              content: [{ type: "text" as const, text: lines.join("\n") }],
            };
          }

          case "slow": {
            const slowCalls = usageTracker.getSlowCalls(threshold);

            if (slowCalls.length === 0) {
              return {
                content: [
                  {
                    type: "text" as const,
                    text: `No tool calls exceeded the ${threshold}ms threshold.`,
                  },
                ],
              };
            }

            const sorted = [...slowCalls]
              .sort((a, b) => b.durationMs - a.durationMs)
              .slice(0, limit);

            const lines: string[] = [
              `## Slow Tool Calls (>${threshold}ms) — ${sorted.length} results`,
              "",
            ];

            for (const call of sorted) {
              const status = call.success ? "✅" : "❌";
              lines.push(
                `${status} \`${call.slug}::${call.toolName}\` — **${call.durationMs}ms**`,
              );
            }

            return {
              content: [{ type: "text" as const, text: lines.join("\n") }],
            };
          }

          case "reset": {
            usageTracker.reset();
            return {
              content: [
                { type: "text" as const, text: "✅ Usage analytics data has been reset." },
              ],
            };
          }

          default:
            return toolError(`Unknown action: ${action}`);
        }
      } catch (err) {
        return toolError(err instanceof Error ? err.message : String(err));
      }
    },
  );
}
