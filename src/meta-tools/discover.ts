import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { RegistryClient } from "../registry/registry-client.js";
import { TRUST_LABELS } from "../permissions/trust-tiers.js";
import { toolError } from "../utils/errors.js";

export function registerDiscover(
  server: McpServer,
  registryClient: RegistryClient,
): void {
  server.tool(
    "mcp_discover",
    "Search the MCP-Rating registry for MCP servers. Returns servers with quality scores, trust tiers, and install information. Use this to find servers before connecting them with mcp_connect.",
    {
      query: z.string().describe("Search query (server name, description, or capability)"),
      category: z.string().optional().describe("Filter by category slug (e.g., 'developer-tools', 'data-databases')"),
      limit: z.number().min(1).max(20).optional().describe("Max results (default 10)"),
    },
    async ({ query, category, limit }) => {
      try {
        const result = await registryClient.search(query, {
          category,
          limit: limit ?? 10,
        });

        if (result.data.length === 0) {
          return {
            content: [
              {
                type: "text" as const,
                text: `No MCP servers found for "${query}". Try a broader search term.`,
              },
            ],
          };
        }

        const lines: string[] = [
          `## MCP Server Search: "${query}"`,
          `Found ${result.total} servers (showing ${result.data.length})\n`,
        ];

        for (const server of result.data) {
          const tier = (
            await import("../registry/registry-client.js")
          ).RegistryClient.determineTrustTier(server);
          const tierLabel = TRUST_LABELS[tier];
          const score = server.qualityScore ?? 0;
          const stars = server.stars ? `${server.stars.toLocaleString()} ★` : "";
          const downloads = server.weeklyDownloads
            ? `${server.weeklyDownloads.toLocaleString()}/wk`
            : "";
          const cat = server.category?.name || "";
          const tools = server.tools?.length
            ? `${server.tools.length} tools`
            : "";
          const discovery = server.supportsDiscovery ? "✓ Discovery" : "";

          const requiresAuth = server.requiresAuth || server.metadata?.requiresAuth;
          const authLabel = requiresAuth ? "🔑 Auth Required" : "";

          // How you run it — the single most useful thing to know at discovery time.
          const amLabels: Record<string, string> = {
            npm: "npx",
            pypi: "uvx",
            docker: "Docker",
            remote: "Remote (URL)",
            "github-manual": "manual build",
          };
          const access = server.accessMethod
            ? amLabels[server.accessMethod] || server.accessMethod
            : "";

          // Surface the safety screen here, not just on connect — "judge before
          // you run" only works if the warning arrives while choosing.
          const safety =
            typeof server.safetyScore === "number" && server.safetyScore < 50
              ? `⚠️ Safety ${server.safetyScore}`
              : "";

          const stats = [access, stars, downloads, cat, tools, discovery, authLabel, safety]
            .filter(Boolean)
            .join(" · ");

          lines.push(
            `### ${server.name}`,
            `**Slug:** \`${server.slug}\` · **Score:** ${score}/100 · **Trust:** [${tierLabel}]`,
            server.description || "_No description_",
            stats ? `📊 ${stats}` : "",
          );

          // Show auth env vars if present
          const authEnvVars = server.authDetails?.envVars || (server.metadata?.authEnvVars as Array<{ name: string; description?: string }>) || [];
          if (authEnvVars.length > 0) {
            lines.push(`🔑 Requires: ${authEnvVars.map(ev => `\`${ev.name}\``).join(", ")}`);
          }

          // Remote servers have no install command by design — you connect by URL.
          // Warning on those read as "broken server" when nothing was wrong.
          lines.push(
            server.installCommand
              ? `🔧 Install: \`${server.installCommand}\``
              : server.accessMethod === "remote"
                ? "🌐 Hosted server — no install needed"
                // Connecting by slug CANNOT work without an install command — the
                // gateway has nothing to spawn. Point at the real options instead.
                : `⚠️ No install command recorded — connect with explicit \`command\`/\`args\`${
                    server.repositoryUrl ? ` (see ${server.repositoryUrl})` : ""
                  }`,
          );

          // Build connect suggestion with env template if auth is required
          if (authEnvVars.length > 0) {
            const envTemplate = authEnvVars
              .map((ev) => `"${ev.name}": "<your-${ev.name.toLowerCase()}>"`)
              .join(", ");
            lines.push(
              `→ Connect: \`mcp_connect({slug: "${server.slug}", env: {${envTemplate}}})\``,
            );
          } else {
            lines.push(
              `→ Connect: \`mcp_connect({slug: "${server.slug}"})\``,
            );
          }

          lines.push("");
        }

        return {
          content: [{ type: "text" as const, text: lines.join("\n") }],
        };
      } catch (err) {
        return toolError(
          `Registry search failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    },
  );
}
