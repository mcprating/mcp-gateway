import { describe, it, expect, vi } from "vitest";
import { registerCallTool } from "./call-tool.js";
import type { ToolCallDeps } from "../proxy/tool-router.js";

/**
 * mcp_call_tool used to call the downstream server directly: a tool the
 * permission policy had blocked (and so never registered) could still be called
 * by name, with no plugin hooks and no audit entry for the call.
 */

type Handler = (
  input: { name: string; arguments: Record<string, unknown> },
  extra?: unknown,
) => Promise<{ isError?: boolean; content: Array<{ text: string }> }>;

function setup(opts: { allowed: (tool: string) => boolean; pluginBlocks?: boolean }) {
  let handler!: Handler;
  const server = {
    tool: (_n: string, _d: string, _s: unknown, h: Handler) => {
      handler = h;
    },
  };
  const callTool = vi.fn(async () => ({ content: [{ type: "text", text: "ran" }] }));
  const connection = {
    slug: "srv",
    displayName: "Srv",
    state: "ready",
    trustTier: "community",
    manifest: { enforcement: "l1-process" },
    tools: new Map([
      ["read", { name: "read", inputSchema: {} }],
      ["delete_everything", { name: "delete_everything", inputSchema: {} }],
    ]),
    client: { callTool },
  };
  const audit: Array<{ type: string; tool?: string; ok?: boolean; reason?: string }> = [];
  const deps: ToolCallDeps = {
    proxyTimeoutMs: 1000,
    permissionManager: { isToolAllowed: (_s: string, t: string) => opts.allowed(t) } as never,
    pluginManager: {
      runBeforeToolCall: async (ctx: unknown) => (opts.pluginBlocks ? null : ctx),
      runAfterToolCall: async (_ctx: unknown, r: unknown) => r,
    } as never,
    auditLog: { record: (e: (typeof audit)[number]) => audit.push(e) } as never,
  };
  registerCallTool(
    server as never,
    { getConnection: () => connection, toolCallDeps: deps } as never,
  );
  return { handler, callTool, audit };
}

describe("mcp_call_tool", () => {
  it("refuses a tool the permission policy blocks, and audits the attempt", async () => {
    const { handler, callTool, audit } = setup({ allowed: (t) => t !== "delete_everything" });
    const res = await handler({ name: "srv__delete_everything", arguments: {} });

    expect(res.isError).toBe(true);
    expect(res.content[0].text).toMatch(/blocked by your permission policy/);
    expect(callTool).not.toHaveBeenCalled();
    expect(audit).toEqual([
      expect.objectContaining({ type: "tool_blocked", tool: "delete_everything", reason: "blocked by permission policy" }),
    ]);
  });

  it("runs plugin hooks, so a plugin can block it", async () => {
    const { handler, callTool, audit } = setup({ allowed: () => true, pluginBlocks: true });
    const res = await handler({ name: "srv__read", arguments: {} });

    expect(res.isError).toBe(true);
    expect(callTool).not.toHaveBeenCalled();
    expect(audit[0]).toMatchObject({ type: "tool_blocked", reason: "blocked by gateway plugin" });
  });

  it("audits an allowed call like a proxied one", async () => {
    const { handler, callTool, audit } = setup({ allowed: () => true });
    const res = await handler({ name: "srv__read", arguments: { q: 1 } });

    expect(res.isError).toBeFalsy();
    expect(callTool).toHaveBeenCalledWith(
      { name: "read", arguments: { q: 1 } },
      undefined,
      expect.anything(),
    );
    expect(audit).toEqual([expect.objectContaining({ type: "tool_call", tool: "read", ok: true })]);
  });
});
