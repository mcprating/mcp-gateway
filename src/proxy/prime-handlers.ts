import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { log } from "../utils/logger.js";

/**
 * Prime the SDK's resource and prompt request handlers BEFORE the transport
 * is connected.
 *
 * Why this exists:
 *   The MCP SDK initializes resource/prompt request handlers lazily — the
 *   first time you call `mcpServer.resource()` / `mcpServer.prompt()`. That
 *   lazy init calls `server.registerCapabilities(...)`, which throws
 *   "Cannot register capabilities after connecting to transport" once a
 *   transport is attached.
 *
 *   The gateway only registers resources/prompts dynamically — AFTER a
 *   downstream server connects (well after the gateway's own transport is up).
 *   So the first dynamic registration would throw, and downstream resources
 *   and prompts would never be proxied to the upstream client.
 *
 *   The fix: register a throwaway resource and prompt at construction time
 *   (before connect) and immediately remove them. This flips the SDK's
 *   one-way `_resourceHandlersInitialized` / `_promptHandlersInitialized`
 *   flags and registers the capabilities while still allowed. Subsequent
 *   dynamic registrations short-circuit the lazy init and never re-register
 *   capabilities — so they no longer throw.
 *
 * Must be called before `mcpServer.connect(transport)`.
 */
export function primeProxyHandlers(mcpServer: McpServer): void {
  // Resources
  try {
    const placeholder = mcpServer.resource(
      "__gateway_capability_init__",
      "gateway-init://capability-priming",
      { description: "Internal capability-priming placeholder (removed immediately)" },
      async () => ({ contents: [] }),
    );
    placeholder.remove();
    log.debug("Primed resource handlers");
  } catch (err) {
    log.warn("Failed to prime resource handlers", { error: String(err) });
  }

  // Prompts
  try {
    const placeholder = mcpServer.prompt(
      "__gateway_capability_init__",
      "Internal capability-priming placeholder (removed immediately)",
      {},
      async () => ({ messages: [] }),
    );
    placeholder.remove();
    log.debug("Primed prompt handlers");
  } catch (err) {
    log.warn("Failed to prime prompt handlers", { error: String(err) });
  }
}
