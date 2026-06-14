import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ConnectionManager } from "../connection/connection-manager.js";
import {
  listNamedProfiles,
  createNamedProfile,
  deleteNamedProfile,
  addToNamedProfile,
  removeFromNamedProfile,
  getActiveProfileName,
  setActiveProfile,
  getProfileConnections,
} from "../config/profiles.js";
import type { TransportType } from "../connection/types.js";
import { toolError } from "../utils/errors.js";

/**
 * Register the `mcp_profiles` meta-tool for managing named connection profiles.
 */
export function registerProfiles(
  server: McpServer,
  connectionManager: ConnectionManager,
  profilesPath: string,
): void {
  server.tool(
    "mcp_profiles",
    "Manage named connection profiles. Profiles are presets of server connections that can be switched between (e.g., 'work', 'personal').",
    {
      action: z
        .enum(["list", "create", "delete", "add_server", "remove_server", "switch", "show"])
        .describe(
          "Action: list (all profiles), create (new profile), delete, add_server (add a server to profile), remove_server, switch (activate profile), show (details of a profile)",
        ),
      name: z
        .string()
        .optional()
        .describe("Profile name (required for create, delete, add_server, remove_server, switch, show)"),
      description: z
        .string()
        .optional()
        .describe("Profile description (optional, for create)"),
      slug: z
        .string()
        .optional()
        .describe("Server slug to add/remove from a profile"),
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
            const profiles = listNamedProfiles(profilesPath);
            const active = getActiveProfileName(profilesPath);

            if (profiles.length === 0) {
              return {
                content: [
                  {
                    type: "text" as const,
                    text: "No named profiles exist yet.\n\nUse `mcp_profiles({action: \"create\", name: \"work\"})` to create one.",
                  },
                ],
              };
            }

            const lines: string[] = [
              `## Connection Profiles (${profiles.length})`,
              "",
            ];

            for (const p of profiles) {
              const isActive = p.name === active ? " ⭐ **active**" : "";
              lines.push(
                `### ${p.name}${isActive}`,
                p.description ? `_${p.description}_` : "",
                `**Servers:** ${p.connections.length}`,
                "",
              );
            }

            return {
              content: [{ type: "text" as const, text: lines.filter(Boolean).join("\n") }],
            };
          }

          case "create": {
            if (!name) return toolError("Profile name is required for 'create'.");
            createNamedProfile(profilesPath, name, description);
            return {
              content: [
                {
                  type: "text" as const,
                  text: `✅ Profile **"${name}"** created.${description ? ` (${description})` : ""}\n\nAdd servers with \`mcp_profiles({action: "add_server", name: "${name}", slug: "..."})\``,
                },
              ],
            };
          }

          case "delete": {
            if (!name) return toolError("Profile name is required for 'delete'.");
            const deleted = deleteNamedProfile(profilesPath, name);
            if (!deleted) return toolError(`Profile "${name}" not found.`);
            return {
              content: [
                { type: "text" as const, text: `✅ Profile **"${name}"** deleted.` },
              ],
            };
          }

          case "add_server": {
            if (!name) return toolError("Profile name is required for 'add_server'.");
            if (!slug && !command && !url) {
              return toolError("Either 'slug', 'command', or 'url' is required to add a server.");
            }

            addToNamedProfile(profilesPath, name, {
              slug,
              command,
              args,
              url,
              transportType: transportType as TransportType | undefined,
              confirmed: true,
            });

            const identifier = slug || command || url;
            return {
              content: [
                {
                  type: "text" as const,
                  text: `✅ Server **${identifier}** added to profile **"${name}"**.`,
                },
              ],
            };
          }

          case "remove_server": {
            if (!name) return toolError("Profile name is required for 'remove_server'.");
            if (!slug) return toolError("Server slug is required to remove a server.");

            removeFromNamedProfile(profilesPath, name, slug);
            return {
              content: [
                {
                  type: "text" as const,
                  text: `✅ Server **${slug}** removed from profile **"${name}"**.`,
                },
              ],
            };
          }

          case "switch": {
            if (!name) return toolError("Profile name is required for 'switch'.");

            // Disconnect all current connections
            await connectionManager.disconnectAll();

            // Set the active profile
            setActiveProfile(profilesPath, name);

            // Connect all servers in the profile
            const connections = getProfileConnections(profilesPath, name);
            const results: string[] = [];

            for (const profile of connections) {
              try {
                await connectionManager.connect({ ...profile, confirmed: true });
                results.push(`✅ ${profile.slug || profile.command || profile.url}`);
              } catch (err) {
                results.push(
                  `❌ ${profile.slug || profile.command || profile.url}: ${err instanceof Error ? err.message : String(err)}`,
                );
              }
            }

            const lines = [
              `## Switched to profile **"${name}"**`,
              "",
              `**Servers:** ${connections.length}`,
              "",
              ...results,
              "",
              `**Active connections:** ${connectionManager.connectionCount}`,
            ];

            return {
              content: [{ type: "text" as const, text: lines.join("\n") }],
            };
          }

          case "show": {
            if (!name) return toolError("Profile name is required for 'show'.");

            const conns = getProfileConnections(profilesPath, name);
            const active = getActiveProfileName(profilesPath);
            const isActive = name === active;

            const lines: string[] = [
              `## Profile: ${name}${isActive ? " ⭐ active" : ""}`,
              "",
              `**Servers:** ${conns.length}`,
              "",
            ];

            for (const c of conns) {
              const transport = c.transportType || "stdio";
              const target = c.slug || c.command || c.url || "unknown";
              lines.push(`- \`${target}\` (${transport})`);
            }

            if (conns.length === 0) {
              lines.push("_No servers in this profile yet._");
            }

            return {
              content: [{ type: "text" as const, text: lines.join("\n") }],
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
