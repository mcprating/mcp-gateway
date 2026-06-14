import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { ConnectionManager } from "../connection/connection-manager.js";
import { parseNamespacedTool } from "../proxy/tool-router.js";
import { buildProgressForwarder } from "../proxy/progress-forwarder.js";
import { toolError } from "../utils/errors.js";
import { log } from "../utils/logger.js";

/**
 * Register the `mcp_call_tool` meta-tool.
 *
 * This is a fallback for MCP clients that don't refresh their tool list
 * when `notifications/tools/list_changed` fires. The AI can call any
 * tool on any connected downstream server by passing the namespaced
 * tool name (e.g. "server-slug__echo") and a JSON arguments object.
 */
export function registerCallTool(
  server: McpServer,
  connectionManager: ConnectionManager,
): void {
  server.tool(
    "mcp_call_tool",
    "Call a tool on a connected MCP server. Use this when dynamically connected tools aren't directly available. Pass the namespaced tool name (slug__toolName) and arguments.",
    {
      name: z
        .string()
        .describe(
          'Namespaced tool name: "server-slug__tool-name" (as shown by mcp_connect or mcp_list_active)',
        ),
      arguments: z
        .record(z.string(), z.unknown())
        .optional()
        .default({})
        .describe("Tool arguments as a JSON object"),
    },
    async (
      { name, arguments: args },
      // Loose-typed extra: see tool-router.ts for the same pattern. We only
      // touch `_meta.progressToken` and `sendNotification` via the helper.
      extra?: unknown,
    ) => {
      try {
        // Parse the namespaced name
        const parsed = parseNamespacedTool(name);
        if (!parsed) {
          return toolError(
            `Invalid tool name "${name}". Expected format: "server-slug__tool-name".`,
          );
        }

        const { slug, toolName } = parsed;

        // Look up the connection
        const connection = connectionManager.getConnection(slug);
        if (!connection) {
          return toolError(
            `Server "${slug}" is not connected. Use mcp_connect first.`,
          );
        }

        if (connection.state !== "ready") {
          return toolError(
            `Server "${slug}" is in state "${connection.state}", not ready.`,
          );
        }

        // Verify the tool exists on the downstream server
        if (!connection.tools.has(toolName)) {
          const available = [...connection.tools.keys()].join(", ");
          return toolError(
            `Tool "${toolName}" not found on "${slug}". Available: ${available}`,
          );
        }

        log.debug("mcp_call_tool proxying", { slug, toolName });

        // Forward progress notifications back to the upstream client
        // using the upstream-supplied progress token (Bug A fix).
        const onprogress = buildProgressForwarder(
          extra as Parameters<typeof buildProgressForwarder>[0],
          { slug, toolName },
        );

        const result = await connection.client.callTool(
          { name: toolName, arguments: args },
          undefined,
          {
            signal: AbortSignal.timeout(30_000),
            ...(onprogress ? { onprogress } : {}),
          },
        );

        return result as CallToolResult;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log.error("mcp_call_tool failed", { name, error: msg });
        return toolError(msg);
      }
    },
  );
}
