import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { ConnectionSummary } from "../connection/types.js";
import type { TrustTier } from "../registry/types.js";
import { log } from "../utils/logger.js";

// ── Plugin Interfaces ────────────────────────────────────────────────────────

export interface ToolCallContext {
  slug: string;
  toolName: string;
  args: Record<string, unknown>;
  trustTier: TrustTier;
}

export interface GatewayPlugin {
  name: string;
  version?: string;

  /** Called before a proxied tool call is forwarded downstream */
  beforeToolCall?(context: ToolCallContext): Promise<ToolCallContext | null>;
  /** Called after a proxied tool call returns */
  afterToolCall?(context: ToolCallContext, result: CallToolResult): Promise<CallToolResult>;
  /** Called when a server connects */
  onConnect?(connection: ConnectionSummary): Promise<void>;
  /** Called when a server disconnects */
  onDisconnect?(slug: string): Promise<void>;
}

// ── Plugin Manager ───────────────────────────────────────────────────────────

/**
 * Manages gateway plugins and runs lifecycle hooks.
 *
 * Plugins are run in registration order.
 * `beforeToolCall` returning null blocks the call.
 * Errors in plugins are logged but don't block the call (fault-tolerant).
 */
export class PluginManager {
  private plugins: GatewayPlugin[] = [];

  /**
   * Register a plugin.
   */
  register(plugin: GatewayPlugin): void {
    // Don't double-register
    if (this.plugins.some((p) => p.name === plugin.name)) {
      log.warn("Plugin already registered, replacing", { name: plugin.name });
      this.plugins = this.plugins.filter((p) => p.name !== plugin.name);
    }

    this.plugins.push(plugin);
    log.info("Plugin registered", {
      name: plugin.name,
      version: plugin.version,
    });
  }

  /**
   * Unregister a plugin by name.
   */
  unregister(name: string): void {
    const before = this.plugins.length;
    this.plugins = this.plugins.filter((p) => p.name !== name);
    if (this.plugins.length < before) {
      log.info("Plugin unregistered", { name });
    }
  }

  /**
   * List all registered plugins.
   */
  listPlugins(): Array<{ name: string; version?: string }> {
    return this.plugins.map((p) => ({
      name: p.name,
      version: p.version,
    }));
  }

  /**
   * Run beforeToolCall hooks in order.
   * Returns null if any plugin blocks the call.
   * Returns the (potentially modified) context otherwise.
   */
  async runBeforeToolCall(
    ctx: ToolCallContext,
  ): Promise<ToolCallContext | null> {
    let currentCtx = ctx;

    for (const plugin of this.plugins) {
      if (!plugin.beforeToolCall) continue;

      try {
        const result = await plugin.beforeToolCall(currentCtx);
        if (result === null) {
          log.info("Tool call blocked by plugin", {
            plugin: plugin.name,
            tool: ctx.toolName,
            server: ctx.slug,
          });
          return null;
        }
        currentCtx = result;
      } catch (err) {
        log.warn("Plugin beforeToolCall error (continuing)", {
          plugin: plugin.name,
          error: String(err),
        });
        // Continue with unmodified context on error
      }
    }

    return currentCtx;
  }

  /**
   * Run afterToolCall hooks in order.
   * Returns the (potentially modified) result.
   */
  async runAfterToolCall(
    ctx: ToolCallContext,
    result: CallToolResult,
  ): Promise<CallToolResult> {
    let currentResult = result;

    for (const plugin of this.plugins) {
      if (!plugin.afterToolCall) continue;

      try {
        currentResult = await plugin.afterToolCall(ctx, currentResult);
      } catch (err) {
        log.warn("Plugin afterToolCall error (continuing)", {
          plugin: plugin.name,
          error: String(err),
        });
        // Continue with unmodified result on error
      }
    }

    return currentResult;
  }

  /**
   * Run onConnect hooks for all plugins.
   */
  async runOnConnect(connection: ConnectionSummary): Promise<void> {
    for (const plugin of this.plugins) {
      if (!plugin.onConnect) continue;

      try {
        await plugin.onConnect(connection);
      } catch (err) {
        log.warn("Plugin onConnect error", {
          plugin: plugin.name,
          error: String(err),
        });
      }
    }
  }

  /**
   * Run onDisconnect hooks for all plugins.
   */
  async runOnDisconnect(slug: string): Promise<void> {
    for (const plugin of this.plugins) {
      if (!plugin.onDisconnect) continue;

      try {
        await plugin.onDisconnect(slug);
      } catch (err) {
        log.warn("Plugin onDisconnect error", {
          plugin: plugin.name,
          error: String(err),
        });
      }
    }
  }
}
