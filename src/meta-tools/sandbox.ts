import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ConnectionManager } from "../connection/connection-manager.js";
import { RegistryClient } from "../registry/registry-client.js";
import {
  ManifestResolver,
  containmentRemedy,
  overrideForSet,
  overrideSlug,
  type ContainmentRemedy,
  type OverrideStart,
  type TrustLookup,
} from "../sandbox/manifest-resolver.js";
import type { CapabilityManifest } from "../sandbox/types.js";
import { toolError } from "../utils/errors.js";

/**
 * Register the `mcp_sandbox` meta-tool — view and customize per-server
 * capability manifests (the sandbox security contract).
 *
 *  - view:  show the effective/saved manifest + a human-readable summary
 *  - set:   override fields (network, env, filesystem, subprocess, enforcement)
 *           — the rest keep what the server would otherwise run with; takes
 *           effect on the next connection to that server
 *  - reset: clear the override, reverting to trust-tier defaults
 */
export function registerSandbox(
  server: McpServer,
  connectionManager: ConnectionManager,
  registryClient: RegistryClient,
): void {
  server.tool(
    "mcp_sandbox",
    "View or customize a server's sandbox capability manifest (env/network/filesystem/subprocess access). Use action 'view' to inspect, 'set' to tighten or loosen grants (only the fields you pass change, the rest keep what the server has now or would get by default; applies on next connect), or 'reset' to revert to defaults.",
    {
      action: z
        .enum(["view", "set", "reset"])
        .describe("view = inspect manifest; set = override grants; reset = revert to defaults"),
      slug: z
        .string()
        .describe(
          "Server slug (as shown by mcp_list_active or mcp_discover), or its registry name (io.github.owner/server)",
        ),
      enforcement: z
        .enum(["none", "l1-process", "l2-container"])
        .optional()
        .describe("[set] Isolation level. l2-container requires Docker/Podman."),
      network: z
        .enum(["none", "allowlist", "all"])
        .optional()
        .describe("[set] Network mode. 'none' = no network, 'allowlist' = only listed hosts, 'all' = unrestricted"),
      networkAllow: z
        .array(z.string())
        .optional()
        .describe("[set] Allowed host:port patterns for allowlist mode, e.g. ['api.github.com:443', '*.example.com']"),
      envAllow: z
        .array(z.string())
        .optional()
        .describe("[set] Environment variable NAMES the server may receive, e.g. ['GITHUB_TOKEN']"),
      fsRead: z.array(z.string()).optional().describe("[set] Absolute paths the server may read"),
      fsWrite: z.array(z.string()).optional().describe("[set] Absolute paths the server may write"),
      subprocess: z.boolean().optional().describe("[set] Whether the server may spawn subprocesses"),
    },
    async (params) => {
      try {
        const resolver = connectionManager.manifestResolver;
        if (!resolver) {
          return toolError("Sandbox is not enabled on this gateway.");
        }

        const { action } = params;

        // A registry name is known by the slug a connect by it gives the
        // server; its lookup also says the trust tier, which "set" may need.
        const byName = params.slug.includes("/")
          ? await lookUpTrust(registryClient, params.slug)
          : undefined;
        const key = overrideSlug(params.slug, byName);
        if ("error" in key) return toolError(key.error);
        const { slug } = key;
        const named =
          slug === params.slug
            ? ""
            : `\`${params.slug}\` is known here by its slug, \`${slug}\`, as a connect by that name is.\n\n`;

        // ── RESET ──────────────────────────────────────────────────────────
        if (action === "reset") {
          resolver.clearOverride(slug);
          return text(
            `## 🛡️ Sandbox override cleared for \`${slug}\`\n\n${named}The server will use trust-tier defaults on the next connection.`,
          );
        }

        // ── VIEW ───────────────────────────────────────────────────────────
        if (action === "view") {
          // Prefer the live connection's resolved manifest, then a saved
          // override, then a note that defaults will apply on connect.
          const conn = connectionManager.getConnection(slug);
          const manifest = conn?.manifest ?? resolver.getOverride(slug);

          if (!manifest) {
            return text(
              `## 🛡️ Sandbox: \`${slug}\`\n\n${named}No saved override and not currently connected. Trust-tier defaults will apply when you connect. Use \`mcp_sandbox({action: "set", slug: "${slug}", ...})\` to pre-configure grants.`,
            );
          }

          const fellBack = conn?.manifest && conn.resolvedManifest;
          const notes = [
            named.trim(),
            fellBack
              ? `Runs as \`${manifest.enforcement}\`: its manifest asks for \`${fellBack.enforcement}\`, but no container engine (Docker or Podman) was found when it connected.`
              : "",
          ].filter(Boolean);
          return text(
            renderManifest(slug, manifest, {
              live: Boolean(conn),
              note: notes.length > 0 ? notes.join("\n\n") : undefined,
              // What would contain a live server depends on how it got here;
              // a saved override keeps the default, which always applies.
              remedy: conn?.manifest
                ? containmentRemedy({
                    resolved: conn.resolvedManifest ?? conn.manifest,
                    trustTier: conn.trustTier,
                    containerIsolation: resolver.containerIsolation,
                    hasOverride: Boolean(resolver.getOverride(slug)),
                  })
                : undefined,
            }),
          );
        }

        // ── SET ────────────────────────────────────────────────────────────
        // Change only the fields given, on top of the saved override, else what
        // the next connect would resolve: the defaults for the server's trust
        // tier. A live connection says which tier and registry record those
        // come from, and so does the latest connect attempt without one. Only
        // then ask the registry: by name if that is what was passed, since
        // another registry's server can't be found by its slug.
        const saved = resolver.getOverride(slug);
        const conn = connectionManager.getConnection(slug);
        const attempt = conn ? undefined : connectionManager.lastTrust(slug);
        const lookup: TrustLookup | undefined = saved
          ? undefined
          : conn
            ? { status: "connection", trustTier: conn.trustTier, server: conn.registryServer }
            : attempt
              ? { status: "last-connect", trustTier: attempt.trustTier, server: attempt.registryServer }
              : (byName ?? (await lookUpTrust(registryClient, slug)));
        const { manifest: updated, start } = overrideForSet(
          slug,
          {
            enforcement: params.enforcement,
            network: params.network,
            networkAllow: params.networkAllow,
            envAllow: params.envAllow,
            fsRead: params.fsRead,
            fsWrite: params.fsWrite,
            subprocess: params.subprocess,
          },
          { saved, lookup },
          resolver.containerIsolation,
        );

        resolver.saveOverride(updated);

        // The live connection keeps what it runs under until a reconnect.
        const fellBack =
          conn?.manifest && conn.resolvedManifest
            ? ` The live connection runs as \`${conn.manifest.enforcement}\`: no container engine (Docker or Podman) was found when it connected.`
            : "";
        return text(
          `## 🛡️ Sandbox override saved for \`${slug}\`\n\n${named}${describeStart(slug, start)}${fellBack}\n\n${renderManifest(slug, updated)}\n\n_Takes effect on the next connection. Reconnect to apply._`,
        );
      } catch (err) {
        return toolError(err instanceof Error ? err.message : String(err));
      }
    },
  );
}

/** A slug's trust tier as the registry gives it, the way a connect by slug looks it up. */
async function lookUpTrust(registryClient: RegistryClient, slug: string): Promise<TrustLookup> {
  try {
    const server = await registryClient.getServer(slug);
    if (!server) return { status: "not-found" };
    return { status: "found", server, trustTier: RegistryClient.determineTrustTier(server) };
  } catch {
    return { status: "unreachable" };
  }
}

/** What the saved override was built on. Fields the call didn't pass came from it. */
function describeStart(slug: string, start: OverrideStart): string {
  switch (start.from) {
    case "override":
      return "Changed the saved override; fields you didn't pass kept their saved values.";
    case "defaults": {
      const tier = `\`${start.trustTier}\``;
      switch (start.lookup) {
        case "connection":
          return `No saved override, so this started from what the next connect would use: the defaults for this connection's trust tier, ${tier}, with any env vars its registry record declares. Env names passed to mcp_connect aren't saved, since each connect allows its own. Fields you didn't pass kept those values.`;
        case "last-connect":
          return `No saved override and not connected, so this started from what the next connect would use: the defaults for the trust tier its last connect attempt worked out, ${tier}, with any env vars its registry record declares. Env names passed to mcp_connect aren't saved, since each connect allows its own. Fields you didn't pass kept those values.`;
        case "found":
          return `No saved override and not connected, so this started from what a connect would use: the ${tier} trust tier's defaults and the env vars the server's registry record declares. Fields you didn't pass kept those values.`;
        case "not-found":
          return `No saved override, not connected, and no connect tried since the gateway started, and \`${slug}\` isn't a registry slug, so this started from the ${tier} trust tier's defaults, the most locked down. A slug like this usually comes from a command, and a connect by command takes its tier from what MCP Rating knows of the package it runs, which this slug doesn't say. If MCP Rating knows the package, this override is stricter than the connect's defaults: \`reset\`, try mcp_connect once (even a refused or failed attempt records the tier), then set again. Fields you didn't pass kept those values.`;
        case "unreachable":
          return `No saved override and not connected, and the MCP-Rating registry couldn't be reached to look up \`${slug}\`, so this started from the ${tier} trust tier's defaults, the most locked down. If the server declares env vars it needs (an API key), they aren't in this override: pass them in \`envAllow\`, or \`reset\` and set again once the registry answers.`;
      }
    }
  }
}

function renderManifest(
  slug: string,
  manifest: CapabilityManifest,
  opts: { live?: boolean; note?: string; remedy?: ContainmentRemedy } = {},
): string {
  const summary = ManifestResolver.summarize(manifest, opts.remedy);
  const lines = [
    `## 🛡️ Sandbox: \`${slug}\`${opts.live ? " (active connection)" : ""}`,
    `**Enforcement:** ${manifest.enforcement}`,
    ...(opts.note ? ["", opts.note] : []),
    "",
    "**Grants:**",
    ...summary.lines.map((l) => `- ${l}`),
    "",
    "**Raw manifest:**",
    "```json",
    JSON.stringify(
      {
        enforcement: manifest.enforcement,
        env: manifest.env,
        network: manifest.network,
        filesystem: manifest.filesystem,
        subprocess: manifest.subprocess,
      },
      null,
      2,
    ),
    "```",
  ];
  return lines.join("\n");
}

function text(t: string) {
  return { content: [{ type: "text" as const, text: t }] };
}
