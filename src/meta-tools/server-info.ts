import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ConnectionManager } from "../connection/connection-manager.js";
import type { RegistryClient } from "../registry/registry-client.js";
import { TRUST_LABELS } from "../permissions/trust-tiers.js";
import { namespaceTool } from "../proxy/tool-router.js";
import { detectLiveUi } from "../proxy/ui-detect.js";
import { toolError } from "../utils/errors.js";

export function registerServerInfo(
  server: McpServer,
  connectionManager: ConnectionManager,
  registryClient: RegistryClient,
): void {
  server.tool(
    "mcp_server_info",
    "Get detailed information about an MCP server from the registry or a currently connected server.",
    {
      slug: z
        .string()
        .describe("Server slug (from registry or connected server)"),
    },
    async ({ slug }) => {
      try {
        // Check if it's a connected server first
        const connected = connectionManager.getConnection(slug);
        const lines: string[] = [];

        // Fetch registry data
        let registryData;
        try {
          registryData = await registryClient.getServer(slug);
        } catch {
          // Registry unreachable — that's okay if we have a live connection
        }

        if (!connected && !registryData) {
          return toolError(
            `Server "${slug}" not found in registry and not currently connected.`,
          );
        }

        // Header
        const name =
          connected?.displayName || registryData?.name || slug;
        lines.push(`## ${name}`, "");

        // Connection status
        if (connected) {
          const tierLabel = TRUST_LABELS[connected.trustTier];
          lines.push(
            `**Status:** 🟢 Connected · **Trust:** [${tierLabel}]`,
          );
          if (connected.serverInfo) {
            lines.push(
              `**Server:** ${connected.serverInfo.name} v${connected.serverInfo.version}`,
            );
          }
          lines.push("");
        } else {
          lines.push("**Status:** ⚪ Not connected", "");
        }

        // Registry info
        if (registryData) {
          const tier = (
            await import("../registry/registry-client.js")
          ).RegistryClient.determineTrustTier(registryData);
          const tierLabel = TRUST_LABELS[tier];
          const score = registryData.qualityScore ?? 0;
          const breakdown = registryData.metadata?.scoreBreakdown as
            | Record<string, number>
            | undefined;

          lines.push("### Registry Info");
          lines.push(`**Quality Score:** ${score}/100 · **Trust:** [${tierLabel}]`);

          if (breakdown) {
            lines.push(
              `**Breakdown:** Popularity ${Math.round(breakdown.popularity ?? 0)} · ` +
                `Freshness ${Math.round(breakdown.freshness ?? 0)} · ` +
                `Completeness ${Math.round(breakdown.completeness ?? 0)} · ` +
                `MCP Compliance ${Math.round(breakdown.mcpCompliance ?? 0)} · ` +
                `Community ${Math.round(breakdown.community ?? 0)}`,
            );
          }

          if (registryData.description) {
            lines.push(`**Description:** ${registryData.description}`);
          }
          if (registryData.author) {
            lines.push(`**Author:** ${registryData.author}`);
          }
          if (registryData.category) {
            lines.push(`**Category:** ${registryData.category.name}`);
          }

          const stats: string[] = [];
          if (registryData.stars)
            stats.push(`${registryData.stars.toLocaleString()} ★`);
          if (registryData.weeklyDownloads)
            stats.push(
              `${registryData.weeklyDownloads.toLocaleString()} downloads/wk`,
            );
          if (registryData.supportsDiscovery)
            stats.push("✓ .well-known/mcp");
          // Heuristic UI capability from the registry ("detected").
          if ((registryData as { supportsUi?: boolean }).supportsUi) {
            const uiType = (registryData as { uiType?: string }).uiType;
            stats.push(`🖼️ UI-capable (detected${uiType ? `: ${uiType}` : ""})`);
          }
          if (stats.length > 0) {
            lines.push(`**Stats:** ${stats.join(" · ")}`);
          }

          if (registryData.installCommand) {
            lines.push(
              `**Install:** \`${registryData.installCommand}\``,
            );
          }

          // Auth requirements
          const requiresAuth = registryData.requiresAuth || registryData.metadata?.requiresAuth;
          if (requiresAuth) {
            lines.push("");
            lines.push("### Authentication Required");
            const authEnvVars = registryData.authDetails?.envVars || (registryData.metadata?.authEnvVars as Array<{ name: string; description?: string }>) || [];
            if (authEnvVars.length > 0) {
              lines.push("Environment variables needed:");
              for (const ev of authEnvVars) {
                lines.push(`- \`${ev.name}\`${ev.description ? `: ${ev.description}` : ""}`);
              }
            }
            const authSchemes = registryData.authDetails?.schemes || (registryData.metadata?.authSchemes as string[]) || [];
            if (authSchemes.length > 0) {
              lines.push(`**Auth schemes:** ${authSchemes.join(", ")}`);
            }
          }

          lines.push("");
        }

        // Live tools (from connection or registry)
        const tools = connected
          ? [...connected.tools.values()]
          : registryData?.tools || [];

        if (tools.length > 0) {
          lines.push(`### Tools (${tools.length})`);
          for (const tool of tools) {
            const nsName = connected
              ? `\`${namespaceTool(slug, tool.name)}\``
              : `\`${tool.name}\``;
            lines.push(
              `- ${nsName}: ${tool.description || "_No description_"}`,
            );
          }
          lines.push("");
        }

        // Authoritative UI capability (live connection only) — inspect actual
        // tool _meta.ui.resourceUri and ui:// resources. This confirms (or
        // refutes) the registry's heuristic "detected" flag.
        if (connected) {
          const liveUi = detectLiveUi(
            connected.tools.values(),
            connected.resources.values(),
          );
          if (liveUi.supportsUi) {
            lines.push("### 🖼️ Interactive UI (confirmed live)");
            if (liveUi.uiTools.length > 0) {
              lines.push(
                `**UI tools:** ${liveUi.uiTools.map((t) => `\`${t}\``).join(", ")}`,
              );
            }
            if (liveUi.uiResources.length > 0) {
              lines.push(
                `**UI resources:** ${liveUi.uiResources.map((u) => `\`${u}\``).join(", ")}`,
              );
            }
            lines.push("");
          }
        }

        // Action suggestions
        if (!connected) {
          if (registryData?.installCommand) {
            lines.push(
              `→ Connect: \`mcp_connect({slug: "${slug}"})\``,
            );
          } else {
            lines.push(
              "⚠️ No install command available. You can connect manually:",
              `\`mcp_connect({command: "npx", args: ["-y", "package-name"]})\``,
            );
          }
        } else {
          lines.push(
            `→ Disconnect: \`mcp_disconnect({slug: "${slug}"})\``,
          );
        }

        return {
          content: [
            { type: "text" as const, text: lines.join("\n") },
          ],
        };
      } catch (err) {
        return toolError(
          `Failed to get server info: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    },
  );
}
