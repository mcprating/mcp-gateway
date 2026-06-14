import type { GatewayPlugin, ToolCallContext } from "../plugin-manager.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { ConnectionSummary } from "../../connection/types.js";
import { log } from "../../utils/logger.js";

/**
 * Built-in logging plugin that logs all tool calls, connections, and disconnections.
 * Serves as both a default plugin and an example for custom plugin development.
 */
export const loggingPlugin: GatewayPlugin = {
  name: "builtin-logging",
  version: "1.0.0",

  async beforeToolCall(ctx: ToolCallContext): Promise<ToolCallContext> {
    log.debug("[plugin:logging] Tool call starting", {
      slug: ctx.slug,
      tool: ctx.toolName,
      trustTier: ctx.trustTier,
      argKeys: Object.keys(ctx.args),
    });
    return ctx;
  },

  async afterToolCall(
    ctx: ToolCallContext,
    result: CallToolResult,
  ): Promise<CallToolResult> {
    log.debug("[plugin:logging] Tool call completed", {
      slug: ctx.slug,
      tool: ctx.toolName,
      isError: result.isError ?? false,
      contentCount: result.content?.length ?? 0,
    });
    return result;
  },

  async onConnect(connection: ConnectionSummary): Promise<void> {
    log.debug("[plugin:logging] Server connected", {
      slug: connection.slug,
      displayName: connection.displayName,
      transportType: connection.transportType,
      toolCount: connection.toolCount,
      resourceCount: connection.resourceCount,
      promptCount: connection.promptCount,
    });
  },

  async onDisconnect(slug: string): Promise<void> {
    log.debug("[plugin:logging] Server disconnected", { slug });
  },
};
