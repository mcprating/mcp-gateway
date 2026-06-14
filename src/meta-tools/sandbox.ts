import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ConnectionManager } from "../connection/connection-manager.js";
import { ManifestResolver } from "../sandbox/manifest-resolver.js";
import type { CapabilityManifest, NetworkMode, EnforcementLevel } from "../sandbox/types.js";
import { toolError } from "../utils/errors.js";

/**
 * Register the `mcp_sandbox` meta-tool — view and customize per-server
 * capability manifests (the sandbox security contract).
 *
 *  - view:  show the effective/saved manifest + a human-readable summary
 *  - set:   override fields (network, env, filesystem, subprocess, enforcement)
 *           — takes effect on the next connection to that server
 *  - reset: clear the override, reverting to trust-tier defaults
 */
export function registerSandbox(
  server: McpServer,
  connectionManager: ConnectionManager,
): void {
  server.tool(
    "mcp_sandbox",
    "View or customize a server's sandbox capability manifest (env/network/filesystem/subprocess access). Use action 'view' to inspect, 'set' to tighten or loosen grants (applies on next connect), or 'reset' to revert to defaults.",
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

          return text(renderManifest(slug, manifest, Boolean(conn)));
        }

        // ── SET ────────────────────────────────────────────────────────────
        // Start from existing override / live manifest / a locked baseline.
        const conn = connectionManager.getConnection(slug);
        const base: CapabilityManifest =
          resolver.getOverride(slug) ??
          conn?.manifest ?? {
            version: 1,
            slug,
            enforcement: "l1-process",
            env: { allow: [], inheritDefaults: true },
            network: { mode: "none", allow: [] },
            filesystem: { read: [], write: [] },
            subprocess: false,
          };

        const updated: CapabilityManifest = {
          ...base,
          slug,
          enforcement: (params.enforcement as EnforcementLevel) ?? base.enforcement,
          env: {
            allow: params.envAllow ?? base.env.allow,
            inheritDefaults: base.env.inheritDefaults,
          },
          network: {
            mode: (params.network as NetworkMode) ?? base.network.mode,
            allow: params.networkAllow ?? base.network.allow,
          },
          filesystem: {
            read: params.fsRead ?? base.filesystem.read,
            write: params.fsWrite ?? base.filesystem.write,
          },
          subprocess: params.subprocess ?? base.subprocess,
        };

        resolver.saveOverride(updated);

        return text(
          `## 🛡️ Sandbox override saved for \`${slug}\`\n\n${renderManifest(slug, updated, false)}\n\n_Takes effect on the next connection. Reconnect to apply._`,
        );
      } catch (err) {
        return toolError(err instanceof Error ? err.message : String(err));
      }
    },
  );
}

function renderManifest(
  slug: string,
  manifest: CapabilityManifest,
  isLive: boolean,
): string {
  const summary = ManifestResolver.summarize(manifest);
  const lines = [
    `## 🛡️ Sandbox: \`${slug}\`${isLive ? " (active connection)" : ""}`,
    `**Enforcement:** ${manifest.enforcement}`,
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
