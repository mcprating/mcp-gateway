import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ConnectionManager } from "../connection/connection-manager.js";
import { RegistryClient } from "../registry/registry-client.js";
import {
  ManifestResolver,
  overrideForSet,
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
      slug: z.string().describe("Server slug (as shown by mcp_list_active or mcp_discover)"),
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

        const { action, slug } = params;

        // ── RESET ──────────────────────────────────────────────────────────
        if (action === "reset") {
          resolver.clearOverride(slug);
          return text(
            `## 🛡️ Sandbox override cleared for \`${slug}\`\n\nThe server will use trust-tier defaults on the next connection.`,
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
              `## 🛡️ Sandbox: \`${slug}\`\n\nNo saved override and not currently connected. Trust-tier defaults will apply when you connect. Use \`mcp_sandbox({action: "set", slug: "${slug}", ...})\` to pre-configure grants.`,
            );
          }

          const fellBack = conn?.manifest && conn.resolvedManifest;
          return text(
            renderManifest(
              slug,
              manifest,
              Boolean(conn),
              fellBack
                ? `Runs as \`${manifest.enforcement}\`: its manifest asks for \`${fellBack.enforcement}\`, but no container engine (Docker or Podman) was found when it connected.`
                : undefined,
            ),
          );
        }

        // ── SET ────────────────────────────────────────────────────────────
        // Change only the fields given, on top of the saved override, else the
        // live connection's manifest, else what a connect would resolve. Only
        // that last one needs the trust tier, and so the registry.
        const saved = resolver.getOverride(slug);
        const conn = connectionManager.getConnection(slug);
        const live = conn?.manifest && { running: conn.manifest, resolved: conn.resolvedManifest };
        const lookup = saved || live ? undefined : await lookUpTrust(registryClient, slug);
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
          { saved, live, lookup },
          resolver.containerIsolation,
        );

        resolver.saveOverride(updated);

        return text(
          `## 🛡️ Sandbox override saved for \`${slug}\`\n\n${describeStart(slug, start)}\n\n${renderManifest(slug, updated, false)}\n\n_Takes effect on the next connection. Reconnect to apply._`,
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
    case "connection":
      if (start.fellBack) {
        const { resolved, running } = start.fellBack;
        return `Started from the manifest this connection resolved, with enforcement \`${resolved}\`, not the \`${running}\` it runs as: no container engine (Docker or Podman) was found when it connected. Fields you didn't pass kept the resolved values.`;
      }
      return "Started from the live connection's manifest; fields you didn't pass kept its values.";
    case "defaults": {
      const tier = `\`${start.trustTier}\``;
      switch (start.lookup) {
        case "found":
          return `No saved override and not connected, so this started from what a connect would use: the ${tier} trust tier's defaults and the env vars the server's registry record declares. Fields you didn't pass kept those values.`;
        case "not-found":
          return `No saved override and not connected, and \`${slug}\` isn't a registry slug, so this started from the ${tier} trust tier's defaults, which a connect by command or URL also gets. Fields you didn't pass kept those values.`;
        case "unreachable":
          return `No saved override and not connected, and the MCP-Rating registry couldn't be reached to look up \`${slug}\`, so this started from the ${tier} trust tier's defaults, the most locked down. If the server declares env vars it needs (an API key), they aren't in this override: pass them in \`envAllow\`, or \`reset\` and set again once the registry answers.`;
      }
    }
  }
}

function renderManifest(
  slug: string,
  manifest: CapabilityManifest,
  isLive: boolean,
  note?: string,
): string {
  const summary = ManifestResolver.summarize(manifest);
  const lines = [
    `## 🛡️ Sandbox: \`${slug}\`${isLive ? " (active connection)" : ""}`,
    `**Enforcement:** ${manifest.enforcement}`,
    ...(note ? ["", note] : []),
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
