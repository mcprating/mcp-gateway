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
        const want = limit ?? 10;
        // Fetch a wider window, then list first what the gateway can start now.
        //
        // Relevance alone put GitHub rows with no install command at the top of
        // "web search". A local 8B went straight for #1 in 4 of 5 runs, got "No
        // install command available", tried #2 (same), and gave up — while a
        // keyless, npx-installable search server sat at #6. The registry is for
        // people too; this ordering is only for an agent, which can use nothing
        // it can't start. Relevance order is kept within each group.
        const result = await registryClient.search(query, {
          category,
          limit: Math.min(want * 2, 40),
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

        // Verified-and-ready first, then ready but untested, then needs setup,
        // then seen failing in our test, then can't start at all.
        const order = { ready: 0, "needs-setup": 2, "failed-in-test": 3, "not-runnable": 4 } as const;
        const rank = (r: ReturnType<RegistryClient["readiness"]>) =>
          r.level === "ready" && !r.verified ? 1 : order[r.level];
        const ranked = result.data
          .map((server, i) => ({ server, i, ready: registryClient.readiness(server) }))
          .sort((a, b) => rank(a.ready) - rank(b.ready) || a.i - b.i)
          .slice(0, want);

        const lines: string[] = [
          `## MCP Server Search: "${query}"`,
          `Found ${result.total} servers (showing ${ranked.length}; ones the gateway can start now are listed first)\n`,
        ];

        for (const { server, ready } of ranked) {
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

          // How it runs, and whether the gateway can start it right now.
          if (ready.via === "install") {
            const install = registryClient.resolveInstallCommand(server)!;
            lines.push(`🔧 Install: \`${[install.command, ...install.args].join(" ")}\``);
            const launcherMissing = ready.missing[0] === install.command;
            if (launcherMissing) {
              lines.push(`⚠️ Needs \`${install.command}\`, which isn't installed on this machine.`);
            }
            const keys = launcherMissing ? ready.missing.slice(1) : ready.missing;
            if (keys.length > 0) {
              // Keys go in the gateway's config, never into a tool call: a value
              // passed through mcp_connect lands in the chat transcript.
              lines.push(
                `🔑 Needs ${keys.map((n) => `\`${n}\``).join(", ")}, not set here. Add it to the gateway's env in the MCP client config and restart the client.`,
              );
            }
          } else if (ready.via === "remote") {
            lines.push(
              ready.missing.length > 0
                ? `🌐 Hosted at ${ready.remote!.url}, but needs the ${ready.missing.map((n) => `\`${n}\``).join(", ")} header, which the gateway can't send yet.`
                : `🌐 Hosted at ${ready.remote!.url} — no install needed.`,
            );
          } else {
            // Nothing to spawn and no endpoint: connecting by slug cannot work.
            lines.push(
              `⚠️ No install command or endpoint recorded — can't connect by slug${
                server.repositoryUrl ? ` (see ${server.repositoryUrl})` : ""
              }`,
            );
          }

          // The registry's own attempt to start it — evidence, not a guess.
          // Never attempted says nothing, rather than implying a failure.
          const v = server.verification;
          if (v) {
            const when = String(v.lastAttemptedAt).slice(0, 10);
            const note = {
              verified: `✓ Started in our test (${when}) and listed its tools.`,
              failed_to_start: `✗ Didn't start in our test (${when}, no credentials given).`,
              needs_credentials: `🔑 Our test (${when}): needs credentials to start.`,
            }[v.latestOutcome as string];
            if (note) lines.push(note);
          }

          if (ready.level !== "not-runnable") {
            lines.push(`→ Connect: \`mcp_connect({slug: "${server.slug}"})\``);
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
