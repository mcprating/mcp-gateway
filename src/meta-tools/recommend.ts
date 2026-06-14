import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AutoRecommender } from "../discovery/auto-recommender.js";
import type { UsageTracker } from "../analytics/usage-tracker.js";
import { toolError } from "../utils/errors.js";

/**
 * Register the `mcp_recommend` meta-tool.
 *
 * Two modes:
 *  - **Intent mode** (`query` provided): searches the registry for servers
 *    matching the goal, with server-side intent expansion (cloud storage →
 *    dropbox/gdrive/onedrive/...).
 *  - **Usage mode** (no `query`): analyzes recent tool-call patterns and
 *    suggests servers that complement the workflow.
 */
export function registerRecommend(
  server: McpServer,
  autoRecommender: AutoRecommender,
  usageTracker: UsageTracker,
): void {
  server.tool(
    "mcp_recommend",
    "Get MCP server recommendations. Pass `query` to describe a goal or task (e.g. \"file sync with cloud storage\", \"manage GitHub issues\"). Omit `query` to get suggestions based on your recent tool-call patterns.",
    {
      query: z
        .string()
        .optional()
        .describe(
          "Free-text goal or task. When provided, recommends servers that match this intent using semantic/keyword/expansion search. When omitted, recommends based on usage history.",
        ),
      category: z
        .string()
        .optional()
        .describe(
          "Optional category slug to filter (e.g. 'developer-tools', 'data-databases'). Only used with `query`.",
        ),
      limit: z
        .number()
        .min(1)
        .max(20)
        .optional()
        .describe("Maximum number of recommendations (default 5, max 20)"),
    },
    async ({ query, category, limit = 5 }) => {
      try {
        const isIntentMode = typeof query === "string" && query.trim().length > 0;

        const recommendations = isIntentMode
          ? await autoRecommender.recommendByQuery(query!.trim(), {
              limit,
              category,
            })
          : await autoRecommender.recommend(
              usageTracker.getRecentCalls(50),
              usageTracker,
            );

        const limited = recommendations.slice(0, limit);

        if (limited.length === 0) {
          return {
            content: [
              {
                type: "text" as const,
                text: isIntentMode
                  ? `No MCP servers found for "${query}". Try a broader description, or use \`mcp_discover\` to search by keyword.`
                  : "No recommendations available right now. Use more tools to build usage patterns, pass a `query` to describe a goal, or try `mcp_discover` to search the registry directly.",
              },
            ],
          };
        }

        const header = isIntentMode
          ? `## Recommended for "${query}" (${limited.length})`
          : `## Recommended Servers (${limited.length})`;

        const subHeader = isIntentMode
          ? `_Best matches in the registry for your goal:_`
          : `_Based on your recent tool usage patterns:_`;

        const lines: string[] = [header, "", subHeader, ""];

        for (const rec of limited) {
          // qualityScore is 0-100 from the registry; display as /100.
          const quality =
            rec.qualityScore > 0
              ? ` · Quality: ${rec.qualityScore.toFixed(0)}/100`
              : "";
          lines.push(
            `### ${rec.name}`,
            `**Slug:** \`${rec.slug}\`${quality}`,
            `**Why:** ${rec.reason}`,
            `→ Connect: \`mcp_connect({slug: "${rec.slug}"})\``,
            "",
          );
        }

        return {
          content: [{ type: "text" as const, text: lines.join("\n") }],
        };
      } catch (err) {
        return toolError(err instanceof Error ? err.message : String(err));
      }
    },
  );
}
