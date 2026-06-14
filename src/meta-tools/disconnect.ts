import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ConnectionManager } from "../connection/connection-manager.js";
import { toolError } from "../utils/errors.js";

export function registerDisconnect(
  server: McpServer,
  connectionManager: ConnectionManager,
): void {
  server.tool(
    "mcp_disconnect",
    "Disconnect from a connected MCP server and remove its tools. Use mcp_list_active to see connected servers.",
    {
      slug: z
        .string()
        .describe("Server slug of the connected server to disconnect"),
    },
    async ({ slug }) => {
      try {
        await connectionManager.disconnect(slug);

        return {
          content: [
            {
              type: "text" as const,
              text: [
                `## ✅ Disconnected: ${slug}`,
                "",
                `All tools from this server have been removed.`,
                `**Active connections:** ${connectionManager.connectionCount}`,
              ].join("\n"),
            },
          ],
        };
      } catch (err) {
        return toolError(
          err instanceof Error ? err.message : String(err),
        );
      }
    },
  );
}
