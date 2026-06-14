import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { buildPassthroughSchema } from "./schema-adapter.js";
import { TRUST_LABELS } from "../permissions/trust-tiers.js";
import type { PermissionManager } from "../permissions/permission-manager.js";
import type {
  DownstreamConnection,
  DownstreamTool,
} from "../connection/types.js";
import { log } from "../utils/logger.js";
import type { AdTracker } from "../ads/ad-tracker.js";
import type { UsageTracker } from "../analytics/usage-tracker.js";
import type { PluginManager } from "../plugins/plugin-manager.js";
import type { AuditLog } from "../audit/audit-log.js";
import { buildProgressForwarder } from "./progress-forwarder.js";
import { isTaskTool, registerTaskProxyTool } from "./task-proxy.js";

const SEPARATOR = "__";

/**
 * Namespace a tool name: `{slug}__{toolname}`
 */
export function namespaceTool(slug: string, toolName: string): string {
  return `${slug}${SEPARATOR}${toolName}`;
}

/**
 * Parse a namespaced tool name back into slug + original tool name.
 */
export function parseNamespacedTool(
  namespacedName: string,
): { slug: string; toolName: string } | null {
  const idx = namespacedName.indexOf(SEPARATOR);
  if (idx === -1) return null;
  return {
    slug: namespacedName.substring(0, idx),
    toolName: namespacedName.substring(idx + SEPARATOR.length),
  };
}

/**
 * Register proxied tools on the gateway McpServer for a downstream connection.
 *
 * Each downstream tool is registered with:
 * - Namespaced name: `slug__toolname`
 * - Description prefixed with trust tier and server name
 * - Passthrough Zod schema (preserves property names, accepts any values)
 * - Callback that forwards to `client.callTool()`
 *
 * Returns a map of namespaced name → { remove } handle for cleanup.
 */
export function registerProxiedTools(
  mcpServer: McpServer,
  connection: DownstreamConnection,
  downstreamTools: DownstreamTool[],
  proxyTimeoutMs: number,
  permissionManager?: PermissionManager,
  adTracker?: AdTracker | null,
  usageTracker?: UsageTracker,
  pluginManager?: PluginManager,
  auditLog?: AuditLog,
): Map<string, { remove: () => void }> {
  const registered = new Map<string, { remove: () => void }>();
  const trustLabel = TRUST_LABELS[connection.trustTier];

  for (const tool of downstreamTools) {
    // Check tool-level permissions if a permission manager is provided
    if (permissionManager && !permissionManager.isToolAllowed(connection.slug, tool.name)) {
      log.info("Tool blocked by permission policy", {
        tool: tool.name,
        server: connection.slug,
      });
      continue;
    }

    const nsName = namespaceTool(connection.slug, tool.name);

    // Task-based tools (experimental) need the task lifecycle, not a plain
    // call. Route them to the dedicated task proxy.
    if (isTaskTool(tool)) {
      try {
        const taskHandle = registerTaskProxyTool(
          mcpServer,
          connection,
          tool,
          proxyTimeoutMs,
          usageTracker,
          adTracker,
        );
        registered.set(nsName, taskHandle);
      } catch (err) {
        log.warn("Failed to register task-proxy tool; skipping", {
          nsName,
          error: err instanceof Error ? err.message : String(err),
        });
      }
      continue;
    }

    // Build description with trust label and optional annotation hints
    const annotationHints = buildAnnotationHints(tool.annotations);
    const description = `[${trustLabel}] [${connection.displayName}]${annotationHints} ${tool.description || tool.name}`;
    const schema = buildPassthroughSchema(
      tool.inputSchema as Record<string, unknown>,
    );

    log.debug("Registering proxied tool", {
      nsName,
      downstream: tool.name,
      server: connection.slug,
    });

    const handle = mcpServer.tool(
      nsName,
      description,
      schema,
      async (
        args: Record<string, unknown>,
        // RequestHandlerExtra from the upstream caller (e.g. Cursor). We type
        // loosely (`unknown`) because the SDK's generic shape is awkward to
        // import here and we only need two fields — captured by the
        // UpstreamProgressContext interface.
        extra?: unknown,
      ) => {
        const startedAt = Date.now();

        log.debug("Proxying tool call", {
          nsName,
          downstream: tool.name,
          server: connection.slug,
        });

        // Run plugin beforeToolCall hooks
        if (pluginManager) {
          const ctx = {
            slug: connection.slug,
            toolName: tool.name,
            args,
            trustTier: connection.trustTier,
          };
          const modifiedCtx = await pluginManager.runBeforeToolCall(ctx);
          if (modifiedCtx === null) {
            // Plugin blocked the call
            auditLog?.record({
              type: "tool_blocked",
              slug: connection.slug,
              tool: tool.name,
              enforcement: connection.manifest?.enforcement,
              reason: "blocked by gateway plugin",
            });
            return {
              content: [
                {
                  type: "text" as const,
                  text: `Tool call blocked by gateway plugin.`,
                },
              ],
              isError: true,
            };
          }
          // Use potentially modified args
          args = modifiedCtx.args;
        }

        // Forward progress notifications back to the upstream client
        // using the upstream-supplied progress token (Bug A fix).
        const onprogress = buildProgressForwarder(
          extra as Parameters<typeof buildProgressForwarder>[0],
          { slug: connection.slug, toolName: tool.name },
        );

        try {
          const result = await connection.client.callTool(
            { name: tool.name, arguments: args },
            undefined,
            {
              signal: AbortSignal.timeout(proxyTimeoutMs),
              ...(onprogress ? { onprogress } : {}),
            },
          );

          const durationMs = Date.now() - startedAt;

          // Track tool usage for ad attribution (fire-and-forget)
          if (adTracker) {
            adTracker.trackToolUsage(connection.slug, tool.name).catch(() => {});
          }

          // Track usage analytics
          if (usageTracker) {
            usageTracker.recordCall({
              slug: connection.slug,
              toolName: tool.name,
              startedAt,
              durationMs,
              success: true,
            });
          }

          // Safety audit: the tool ran under its sandbox enforcement level.
          auditLog?.record({
            type: "tool_call",
            slug: connection.slug,
            tool: tool.name,
            enforcement: connection.manifest?.enforcement,
            ok: true,
          });

          // Run plugin afterToolCall hooks
          let finalResult = result as CallToolResult;
          if (pluginManager) {
            finalResult = await pluginManager.runAfterToolCall(
              {
                slug: connection.slug,
                toolName: tool.name,
                args,
                trustTier: connection.trustTier,
              },
              finalResult,
            );
          }

          return finalResult;
        } catch (err) {
          const durationMs = Date.now() - startedAt;
          const msg =
            err instanceof Error ? err.message : String(err);
          log.error("Proxied tool call failed", {
            nsName,
            error: msg,
          });

          // Track failed call analytics
          if (usageTracker) {
            usageTracker.recordCall({
              slug: connection.slug,
              toolName: tool.name,
              startedAt,
              durationMs,
              success: false,
              error: msg,
            });
          }

          // Safety audit: the tool call errored (forensics — what failed).
          auditLog?.record({
            type: "tool_call",
            slug: connection.slug,
            tool: tool.name,
            enforcement: connection.manifest?.enforcement,
            ok: false,
            reason: msg.slice(0, 200),
          });

          return {
            content: [
              {
                type: "text" as const,
                text: `Error from ${connection.displayName}: ${msg}`,
              },
            ],
            isError: true,
          };
        }
      },
    );

    registered.set(nsName, handle);
  }

  return registered;
}

/**
 * Remove all proxied tools for a connection.
 */
export function removeProxiedTools(
  proxies: Map<string, { remove: () => void }>,
): void {
  for (const [name, handle] of proxies) {
    log.debug("Removing proxied tool", { name });
    handle.remove();
  }
  proxies.clear();
}

/**
 * Build a compact annotation hint string from tool annotations.
 * E.g. " [read-only]" or " [destructive]" or "" if no relevant annotations.
 */
function buildAnnotationHints(
  annotations: Record<string, unknown> | undefined,
): string {
  if (!annotations) return "";

  const hints: string[] = [];

  if (annotations.readOnlyHint === true) hints.push("read-only");
  if (annotations.destructiveHint === true) hints.push("destructive");
  if (annotations.idempotentHint === true) hints.push("idempotent");
  if (annotations.openWorldHint === true) hints.push("open-world");

  return hints.length > 0 ? ` [${hints.join(", ")}]` : "";
}
