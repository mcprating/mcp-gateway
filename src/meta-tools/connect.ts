import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ConnectionManager } from "../connection/connection-manager.js";
import { isConfirmationRequired } from "../connection/types.js";
import { namespaceTool } from "../proxy/tool-router.js";
import { TRUST_LABELS } from "../permissions/trust-tiers.js";
import { ManifestResolver } from "../sandbox/manifest-resolver.js";
import { toolError } from "../utils/errors.js";

export function registerConnect(
  server: McpServer,
  connectionManager: ConnectionManager,
): void {
  server.tool(
    "mcp_connect",
    "Connect to an MCP server and make its tools available. Provide either a server slug (from mcp_discover) to look up in the registry, OR an explicit command + args to spawn directly, OR a url for remote servers.",
    {
      slug: z
        .string()
        .optional()
        .describe(
          "Server slug from MCP-Rating registry (e.g., '@modelcontextprotocol/inspector')",
        ),
      command: z
        .string()
        .optional()
        .describe(
          "Explicit command to spawn (e.g., 'npx'). Use when server is not in registry.",
        ),
      args: z
        .array(z.string())
        .optional()
        .describe(
          "Command arguments (e.g., ['-y', '@modelcontextprotocol/server-everything'])",
        ),
      url: z
        .string()
        .optional()
        .describe(
          "URL for remote transports (SSE, WebSocket, Streamable HTTP). Use instead of command for remote servers.",
        ),
      transportType: z
        .enum(["stdio", "sse", "websocket", "streamable-http"])
        .optional()
        .describe(
          "Transport type. Defaults to 'stdio' for command-based, auto-detected from URL scheme if url is provided.",
        ),
      env: z
        .record(z.string(), z.string())
        .optional()
        .describe("Additional environment variables for the server process"),
      confirmed: z
        .boolean()
        .optional()
        .describe(
          "Set to true to confirm connection to community/unknown trust tier servers. Required when the initial connect returns a confirmation warning.",
        ),
      saveProfile: z
        .boolean()
        .optional()
        .describe(
          "Set to true to save this connection as an auto-connect profile. The server will auto-reconnect on gateway restart.",
        ),
    },
    async ({ slug, command, args, url, transportType, env, confirmed, saveProfile }) => {
      try {
        const result = await connectionManager.connect({
          slug,
          command,
          args,
          url,
          transportType,
          env,
          confirmed,
          saveProfile,
        });

        // If confirmation is required, return the warning for the AI to relay
        if (isConfirmationRequired(result)) {
          return {
            content: [
              { type: "text" as const, text: result.warning },
            ],
          };
        }

        const summary = result;
        const tierLabel = TRUST_LABELS[summary.trustTier];
        const conn = connectionManager.getConnection(summary.slug);
        const toolNames = [...(conn?.tools.keys() || [])];
        const namespacedTools = toolNames.map((t) =>
          namespaceTool(summary.slug, t),
        );

        const lines: string[] = [
          `## ✅ Connected: ${summary.displayName}`,
          `**Trust:** [${tierLabel}] · **Transport:** ${summary.transportType} · **Tools:** ${summary.toolCount}`,
          summary.serverInfo
            ? `**Server:** ${summary.serverInfo.name} v${summary.serverInfo.version}`
            : "",
          "",
          "### Available Tools",
          ...namespacedTools.map((t) => `- \`${t}\``),
        ];

        if (summary.resourceCount > 0) {
          lines.push("", `### Resources (${summary.resourceCount})`);
          for (const uri of conn?.resources.keys() || []) {
            lines.push(`- \`${summary.slug}://${uri}\``);
          }
        }

        if (summary.promptCount > 0) {
          lines.push("", `### Prompts (${summary.promptCount})`);
          for (const name of conn?.prompts.keys() || []) {
            lines.push(`- \`${summary.slug}__${name}\``);
          }
        }

        // Sandbox: show what the server was granted access to (L1)
        if (conn?.manifest) {
          const summ = ManifestResolver.summarize(conn.manifest);
          lines.push(
            "",
            `### 🛡️ Sandbox (${summ.enforcement})`,
            ...summ.lines.map((l) => `- ${l}`),
          );
        }

        lines.push(
          "",
          `**Active connections:** ${connectionManager.connectionCount}`,
          "",
          `To disconnect: \`mcp_disconnect({slug: "${summary.slug}"})\``,
        );

        return {
          content: [
            { type: "text" as const, text: lines.filter(Boolean).join("\n") },
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
