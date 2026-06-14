import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ConnectionManager } from "../connection/connection-manager.js";
import {
  createGroup,
  deleteGroup,
  listGroups,
  getGroup,
  addToGroup,
  removeFromGroup,
  groupToConnectParams,
} from "../config/groups.js";
import type { TransportType } from "../connection/types.js";
import { toolError } from "../utils/errors.js";

// Default groups path — lives alongside profiles
const DEFAULT_GROUPS_PATH_SUFFIX = "mcp-gateway-groups.json";

/**
 * Register the `mcp_groups` meta-tool for managing server groups.
 * Groups allow atomic connect/disconnect of sets of servers.
 */
export function registerGroups(
  server: McpServer,
  connectionManager: ConnectionManager,
  groupsPath: string,
): void {
  server.tool(
    "mcp_groups",
    "Manage server groups for atomic connect/disconnect of sets of servers.",
    {
      action: z
        .enum(["list", "create", "delete", "add_server", "remove_server", "connect", "disconnect", "show"])
        .describe(
          "Action: list, create, delete, add_server, remove_server, connect (all in group), disconnect (all in group), show (details)",
        ),
      name: z
        .string()
        .optional()
        .describe("Group name (required for all actions except list)"),
      description: z
        .string()
        .optional()
        .describe("Group description (optional, for create)"),
      slug: z
        .string()
        .optional()
        .describe("Server slug to add/remove from a group"),
      command: z
        .string()
        .optional()
        .describe("Explicit command for the server (for add_server with stdio)"),
      args: z
        .array(z.string())
        .optional()
        .describe("Command arguments (for add_server with stdio)"),
      url: z
        .string()
        .optional()
        .describe("Server URL (for add_server with SSE/WS/HTTP)"),
      transportType: z
        .enum(["stdio", "sse", "websocket", "streamable-http"])
        .optional()
        .describe("Transport type (for add_server)"),
    },
    async ({ action, name, description, slug, command, args, url, transportType }) => {
      try {
        switch (action) {
          case "list": {
            const groups = listGroups(groupsPath);

            if (groups.length === 0) {
              return {
                content: [
                  {
                    type: "text" as const,
                    text: "No server groups exist yet.\n\nUse `mcp_groups({action: \"create\", name: \"my-group\"})` to create one.",
                  },
                ],
              };
            }

            const lines: string[] = [
              `## Server Groups (${groups.length})`,
              "",
            ];

            for (const g of groups) {
              lines.push(
                `### ${g.name}`,
                g.description ? `_${g.description}_` : "",
                `**Servers:** ${g.servers.length}`,
                "",
              );
            }

            return {
              content: [{ type: "text" as const, text: lines.filter(Boolean).join("\n") }],
            };
          }

          case "create": {
            if (!name) return toolError("Group name is required for 'create'.");
            createGroup(groupsPath, name, description);
            return {
              content: [
                {
                  type: "text" as const,
                  text: `✅ Group **"${name}"** created.${description ? ` (${description})` : ""}\n\nAdd servers with \`mcp_groups({action: "add_server", name: "${name}", slug: "..."})\``,
                },
              ],
            };
          }

          case "delete": {
            if (!name) return toolError("Group name is required for 'delete'.");
            const deleted = deleteGroup(groupsPath, name);
            if (!deleted) return toolError(`Group "${name}" not found.`);
            return {
              content: [
                { type: "text" as const, text: `✅ Group **"${name}"** deleted.` },
              ],
            };
          }

          case "add_server": {
            if (!name) return toolError("Group name is required for 'add_server'.");
            if (!slug && !command && !url) {
              return toolError("Either 'slug', 'command', or 'url' is required to add a server.");
            }

            addToGroup(groupsPath, name, {
              slug,
              command,
              args,
              url,
              transportType: transportType as TransportType | undefined,
            });

            const identifier = slug || command || url;
            return {
              content: [
                {
                  type: "text" as const,
                  text: `✅ Server **${identifier}** added to group **"${name}"**.`,
                },
              ],
            };
          }

          case "remove_server": {
            if (!name) return toolError("Group name is required for 'remove_server'.");
            if (!slug) return toolError("Server slug is required to remove a server.");

            removeFromGroup(groupsPath, name, slug);
            return {
              content: [
                {
                  type: "text" as const,
                  text: `✅ Server **${slug}** removed from group **"${name}"**.`,
                },
              ],
            };
          }

          case "connect": {
            if (!name) return toolError("Group name is required for 'connect'.");

            const group = getGroup(groupsPath, name);
            if (!group) return toolError(`Group "${name}" not found.`);
            if (group.servers.length === 0) {
              return toolError(`Group "${name}" has no servers.`);
            }

            const params = groupToConnectParams(group);
            const results: string[] = [];
            let successCount = 0;

            // Connect all servers in parallel
            const outcomes = await Promise.allSettled(
              params.map((p) => connectionManager.connect(p)),
            );

            for (let i = 0; i < outcomes.length; i++) {
              const outcome = outcomes[i];
              const identifier = params[i].slug || params[i].command || params[i].url || "unknown";

              if (outcome.status === "fulfilled") {
                successCount++;
                results.push(`✅ ${identifier}`);
              } else {
                const reason = outcome.reason instanceof Error
                  ? outcome.reason.message
                  : String(outcome.reason);
                results.push(`❌ ${identifier}: ${reason}`);
              }
            }

            const lines = [
              `## Group "${name}" — Connect Results`,
              "",
              `**Success:** ${successCount}/${params.length}`,
              "",
              ...results,
              "",
              `**Active connections:** ${connectionManager.connectionCount}`,
            ];

            return {
              content: [{ type: "text" as const, text: lines.join("\n") }],
            };
          }

          case "disconnect": {
            if (!name) return toolError("Group name is required for 'disconnect'.");

            const group = getGroup(groupsPath, name);
            if (!group) return toolError(`Group "${name}" not found.`);

            const results: string[] = [];
            let successCount = 0;

            for (const entry of group.servers) {
              const identifier = entry.slug || entry.command || entry.url || "unknown";
              try {
                await connectionManager.disconnect(identifier, { removeProfile: false });
                successCount++;
                results.push(`✅ ${identifier}`);
              } catch (err) {
                results.push(
                  `❌ ${identifier}: ${err instanceof Error ? err.message : String(err)}`,
                );
              }
            }

            const lines = [
              `## Group "${name}" — Disconnect Results`,
              "",
              `**Disconnected:** ${successCount}/${group.servers.length}`,
              "",
              ...results,
            ];

            return {
              content: [{ type: "text" as const, text: lines.join("\n") }],
            };
          }

          case "show": {
            if (!name) return toolError("Group name is required for 'show'.");

            const group = getGroup(groupsPath, name);
            if (!group) return toolError(`Group "${name}" not found.`);

            const lines: string[] = [
              `## Group: ${group.name}`,
              group.description ? `_${group.description}_` : "",
              "",
              `**Servers:** ${group.servers.length}`,
              "",
            ];

            for (const s of group.servers) {
              const transport = s.transportType || "stdio";
              const target = s.slug || s.command || s.url || "unknown";
              lines.push(`- \`${target}\` (${transport})`);
            }

            if (group.servers.length === 0) {
              lines.push("_No servers in this group yet._");
            }

            return {
              content: [{ type: "text" as const, text: lines.filter(Boolean).join("\n") }],
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
