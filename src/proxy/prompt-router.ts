import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { TRUST_LABELS } from "../permissions/trust-tiers.js";
import type {
  DownstreamConnection,
  DownstreamPrompt,
} from "../connection/types.js";
import { log } from "../utils/logger.js";

const SEPARATOR = "__";

/**
 * Namespace a prompt name: `{slug}__{promptname}`
 */
export function namespacePrompt(slug: string, promptName: string): string {
  return `${slug}${SEPARATOR}${promptName}`;
}

/**
 * Register proxied prompts on the gateway McpServer for a downstream connection.
 *
 * Each downstream prompt is registered with:
 * - Namespaced name: `slug__promptname`
 * - Description prefixed with trust tier and server name
 * - Get handler that forwards to `client.getPrompt()`
 *
 * Returns a map of namespaced name → { remove } handle for cleanup.
 */
export function registerProxiedPrompts(
  mcpServer: McpServer,
  connection: DownstreamConnection,
  downstreamPrompts: DownstreamPrompt[],
): Map<string, { remove: () => void }> {
  const registered = new Map<string, { remove: () => void }>();
  const trustLabel = TRUST_LABELS[connection.trustTier];

  for (const prompt of downstreamPrompts) {
    const nsName = namespacePrompt(connection.slug, prompt.name);
    const description = `[${trustLabel}] [${connection.displayName}] ${prompt.description || prompt.name}`;

    log.debug("Registering proxied prompt", {
      nsName,
      downstream: prompt.name,
      server: connection.slug,
    });

    try {
      // Build args schema from prompt arguments
      const argsSchema: Record<string, z.ZodTypeAny> = {};
      if (prompt.arguments) {
        for (const arg of prompt.arguments) {
          if (arg.required) {
            argsSchema[arg.name] = z
              .string()
              .describe(arg.description || arg.name);
          } else {
            argsSchema[arg.name] = z
              .string()
              .optional()
              .describe(arg.description || arg.name);
          }
        }
      }

      const handle = mcpServer.prompt(
        nsName,
        description,
        argsSchema,
        async (args: Record<string, unknown>) => {
          log.debug("Proxying prompt get", {
            nsName,
            downstream: prompt.name,
            server: connection.slug,
          });

          try {
            // Convert args to string values for the downstream prompt
            const stringArgs: Record<string, string> = {};
            for (const [key, value] of Object.entries(args)) {
              if (value !== undefined && value !== null) {
                stringArgs[key] = String(value);
              }
            }

            const result = await connection.client.getPrompt({
              name: prompt.name,
              arguments: stringArgs,
            });
            return result;
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            log.error("Proxied prompt get failed", {
              nsName,
              error: msg,
            });
            return {
              messages: [
                {
                  role: "user" as const,
                  content: {
                    type: "text" as const,
                    text: `Error getting prompt from ${connection.displayName}: ${msg}`,
                  },
                },
              ],
            };
          }
        },
      );

      registered.set(nsName, handle);
    } catch (err) {
      log.warn("Failed to register proxied prompt", {
        nsName,
        error: String(err),
      });
    }
  }

  return registered;
}

/**
 * Remove all proxied prompts for a connection.
 */
export function removeProxiedPrompts(
  proxies: Map<string, { remove: () => void }>,
): void {
  for (const [name, handle] of proxies) {
    log.debug("Removing proxied prompt", { name });
    handle.remove();
  }
  proxies.clear();
}
