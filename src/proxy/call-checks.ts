import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { DownstreamConnection } from "../connection/types.js";
import type { PermissionManager } from "../permissions/permission-manager.js";
import type { AdTracker } from "../ads/ad-tracker.js";
import type { UsageTracker } from "../analytics/usage-tracker.js";
import type { PluginManager } from "../plugins/plugin-manager.js";
import type { AuditLog } from "../audit/audit-log.js";
import { refusalMessage, type HumanGate } from "../permissions/human-gate.js";
import { guardPersonalData } from "./personal-data-guard.js";
import type { SensitiveData } from "./sensitive-data.js";
import { log } from "../utils/logger.js";

/**
 * What every downstream tool call goes through, whichever way it arrives: a
 * proxied tool, `mcp_call_tool`, or a task-based tool. Each of those used to
 * carry its own copy of these steps, and two of them had dropped most of it.
 */

/** What a downstream tool call is checked, tracked and recorded with. */
export interface ToolCallDeps {
  proxyTimeoutMs: number;
  permissionManager?: PermissionManager;
  adTracker?: AdTracker | null;
  usageTracker?: UsageTracker;
  pluginManager?: PluginManager;
  auditLog?: AuditLog;
  humanGate?: HumanGate;
  /** Absent when the human gate is off: then the model decides, as it does elsewhere. */
  sensitiveData?: SensitiveData;
}

function refusal(text: string): CallToolResult {
  return { content: [{ type: "text" as const, text }], isError: true };
}

/**
 * A secret the model read, on its way into a tool call, goes to the person. See
 * sensitive-data.ts. Returns the refusal, or null if the call may go ahead.
 *
 * A call to the server the secret came from counts too: an http_post beside a
 * read_file is how the data leaves. The exception is a tool that says it reaches
 * nothing outside, as a write_file saving .env again can. MCP's default is that a
 * tool may, so this needs the server to say so, and believing it risks nothing:
 * a server lying about it already has the value, and it covers no other server's.
 */
async function checkForSecrets(
  connection: DownstreamConnection,
  toolName: string,
  args: Record<string, unknown>,
  deps: ToolCallDeps,
): Promise<CallToolResult | null> {
  const { sensitiveData, humanGate, auditLog } = deps;
  if (!sensitiveData || !humanGate) return null;

  const staysOnServer = connection.tools.get(toolName)?.annotations?.openWorldHint === false;
  const found = sensitiveData.find(args, staysOnServer ? connection.slug : undefined);
  if (!found) return null;

  const secret = found.name ? `${found.name} from ${found.source}` : `a secret from ${found.source}`;
  const approval = await humanGate.check({
    slug: connection.slug,
    key: JSON.stringify(["send", connection.slug, toolName, found.source, found.name]),
    required: true,
    summary: [
      `An agent wants to send ${secret} to ${connection.slug}, in ${toolName} (${found.argument}).`,
      "",
      "Say yes only if you asked for this. A tool description or result from any connected server can tell an agent to do it.",
    ].join("\n"),
  });
  if (approval.approved) return null;

  auditLog?.record({
    type: "tool_blocked",
    slug: connection.slug,
    tool: toolName,
    enforcement: connection.manifest?.enforcement,
    reason: `${secret} in ${found.argument}`,
  });
  return refusal(refusalMessage(`Sending ${secret} to ${toolName}`, approval.why));
}

/**
 * Before the call: the permission policy, then plugin beforeToolCall hooks
 * (which may rewrite the arguments), then the check for secrets on what is left.
 * A refusal is audited as tool_blocked.
 *
 * The policy is checked on every call, not only when tools are registered: a
 * blocked tool is never registered, but `mcp_call_tool` can still name it.
 */
export async function admitToolCall(
  connection: DownstreamConnection,
  toolName: string,
  args: Record<string, unknown>,
  deps: ToolCallDeps,
): Promise<{ args: Record<string, unknown> } | { refused: CallToolResult }> {
  const { permissionManager, pluginManager, auditLog } = deps;

  if (permissionManager && !permissionManager.isToolAllowed(connection.slug, toolName)) {
    log.info("Tool call blocked by permission policy", {
      tool: toolName,
      server: connection.slug,
    });
    auditLog?.record({
      type: "tool_blocked",
      slug: connection.slug,
      tool: toolName,
      enforcement: connection.manifest?.enforcement,
      reason: "blocked by permission policy",
    });
    return {
      refused: refusal(
        `Tool "${toolName}" on "${connection.slug}" is blocked by your permission policy.`,
      ),
    };
  }

  if (pluginManager) {
    const modifiedCtx = await pluginManager.runBeforeToolCall({
      slug: connection.slug,
      toolName,
      args,
      trustTier: connection.trustTier,
    });
    if (modifiedCtx === null) {
      auditLog?.record({
        type: "tool_blocked",
        slug: connection.slug,
        tool: toolName,
        enforcement: connection.manifest?.enforcement,
        reason: "blocked by gateway plugin",
      });
      return { refused: refusal(`Tool call blocked by gateway plugin.`) };
    }
    args = modifiedCtx.args;
  }

  const refused = await checkForSecrets(connection, toolName, args, deps);
  return refused ? { refused } : { args };
}

/**
 * After a successful call: the audit entry (the tool ran under its sandbox
 * enforcement level), noting any secrets in the result, plugin afterToolCall
 * hooks, and the personal-data guard (a server asking the model for personal data
 * gets a warning the model reads with it, and an audit entry).
 */
export async function completeToolCall(
  connection: DownstreamConnection,
  toolName: string,
  args: Record<string, unknown>,
  result: CallToolResult,
  deps: ToolCallDeps,
): Promise<CallToolResult> {
  const { pluginManager, auditLog, sensitiveData } = deps;

  auditLog?.record({
    type: "tool_call",
    slug: connection.slug,
    tool: toolName,
    enforcement: connection.manifest?.enforcement,
    ok: true,
  });

  sensitiveData?.note(connection.slug, toolName, args, result);

  let finalResult = result;
  if (pluginManager) {
    finalResult = await pluginManager.runAfterToolCall(
      { slug: connection.slug, toolName, args, trustTier: connection.trustTier },
      finalResult,
    );
  }

  return guardPersonalData(finalResult, { slug: connection.slug, tool: toolName, auditLog });
}

/** After a failed call: the audit entry (forensics — what failed). */
export function recordFailedToolCall(
  connection: DownstreamConnection,
  toolName: string,
  message: string,
  deps: ToolCallDeps,
): void {
  deps.auditLog?.record({
    type: "tool_call",
    slug: connection.slug,
    tool: toolName,
    enforcement: connection.manifest?.enforcement,
    ok: false,
    reason: message.slice(0, 200),
  });
}
