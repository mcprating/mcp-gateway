import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { TRUST_LABELS } from "../permissions/trust-tiers.js";
import type {
  DownstreamConnection,
  DownstreamResource,
} from "../connection/types.js";
import { log } from "../utils/logger.js";

/**
 * Register proxied resources on the gateway McpServer for a downstream connection.
 *
 * Each downstream resource is registered with:
 * - Namespaced URI: `slug://original-uri`
 * - Description prefixed with trust tier and server name
 * - Read handler that forwards to downstream `client.readResource()`
 *
 * Returns a map of namespaced URI → { remove } handle for cleanup.
 */
export function registerProxiedResources(
  mcpServer: McpServer,
  connection: DownstreamConnection,
  downstreamResources: DownstreamResource[],
): Map<string, { remove: () => void }> {
  const registered = new Map<string, { remove: () => void }>();
  const trustLabel = TRUST_LABELS[connection.trustTier];

  for (const resource of downstreamResources) {
    const nsUri = namespaceResourceUri(connection.slug, resource.uri);
    const description = `[${trustLabel}] [${connection.displayName}] ${resource.description || resource.name}`;

    log.debug("Registering proxied resource", {
      nsUri,
      downstream: resource.uri,
      server: connection.slug,
    });

    try {
      const handle = mcpServer.resource(
        resource.name,
        nsUri,
        {
          description,
          mimeType: resource.mimeType,
        },
        async () => {
          log.debug("Proxying resource read", {
            nsUri,
            downstream: resource.uri,
            server: connection.slug,
          });

          try {
            const result = await connection.client.readResource({
              uri: resource.uri,
            });
            return result;
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            log.error("Proxied resource read failed", {
              nsUri,
              error: msg,
            });
            return {
              contents: [
                {
                  uri: nsUri,
                  text: `Error reading resource from ${connection.displayName}: ${msg}`,
                },
              ],
            };
          }
        },
      );

      registered.set(nsUri, handle);
    } catch (err) {
      log.warn("Failed to register proxied resource", {
        nsUri,
        error: String(err),
      });
    }
  }

  return registered;
}

/**
 * Remove all proxied resources for a connection.
 */
export function removeProxiedResources(
  proxies: Map<string, { remove: () => void }>,
): void {
  for (const [uri, handle] of proxies) {
    log.debug("Removing proxied resource", { uri });
    handle.remove();
  }
  proxies.clear();
}

/**
 * Namespace a resource URI: `slug://original-uri-path`
 */
export function namespaceResourceUri(slug: string, originalUri: string): string {
  // If the original URI has a scheme, replace it with slug://
  try {
    const parsed = new URL(originalUri);
    return `${slug}://${parsed.host}${parsed.pathname}${parsed.search}${parsed.hash}`;
  } catch {
    // Not a valid URL — just prepend the slug scheme
    return `${slug}://${originalUri}`;
  }
}
