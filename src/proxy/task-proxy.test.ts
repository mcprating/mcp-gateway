import { describe, it, expect, vi } from "vitest";
import { registerTaskProxyTool } from "./task-proxy.js";
import type { ToolCallDeps } from "./call-checks.js";

/**
 * Task-based tools used to run with no permission check at call time, no plugin
 * hooks, no personal-data guard and no audit entry.
 */

type CreateTask = (
  args: Record<string, unknown>,
  extra: unknown,
) => Promise<{ task: { taskId: string } }>;

function setup(opts: { allowed: boolean; result?: unknown }) {
  let createTask!: CreateTask;
  const mcpServer = {
    experimental: {
      tasks: {
        registerToolTask: (_n: string, _c: unknown, h: { createTask: CreateTask }) => {
          createTask = h.createTask;
          return { remove: vi.fn() };
        },
      },
    },
  };
  const callToolStream = vi.fn(async function* () {
    yield { type: "result", result: opts.result ?? { content: [{ type: "text", text: "done" }] } };
  });
  const connection = {
    slug: "srv",
    displayName: "Srv",
    trustTier: "community",
    manifest: { enforcement: "l2-container" },
    client: { experimental: { tasks: { callToolStream } } },
  };
  const audit: Array<{ type: string; tool?: string; ok?: boolean; reason?: string }> = [];
  const deps: ToolCallDeps = {
    proxyTimeoutMs: 1000,
    permissionManager: { isToolAllowed: () => opts.allowed } as never,
    auditLog: { record: (e: (typeof audit)[number]) => audit.push(e) } as never,
  };
  registerTaskProxyTool(
    mcpServer as never,
    connection as never,
    { name: "long_job", inputSchema: {}, execution: { taskSupport: "required" } },
    deps,
  );

  const stored: Array<{ status: string; result: { isError?: boolean; content: Array<{ text: string }> } }> = [];
  const taskStore = {
    createTask: async () => ({ taskId: "t1", status: "working" }),
    storeTaskResult: async (_id: string, status: string, result: (typeof stored)[number]["result"]) => {
      stored.push({ status, result });
    },
    updateTaskStatus: async () => {},
  };
  return { run: () => createTask({}, { taskStore }), callToolStream, audit, stored };
}

describe("task-based tools", () => {
  it("refuse a blocked tool without starting it, and audit the attempt", async () => {
    const { run, callToolStream, audit, stored } = setup({ allowed: false });
    await run();

    expect(callToolStream).not.toHaveBeenCalled();
    expect(stored).toEqual([
      { status: "failed", result: expect.objectContaining({ isError: true }) },
    ]);
    expect(audit).toEqual([
      expect.objectContaining({ type: "tool_blocked", tool: "long_job", reason: "blocked by permission policy" }),
    ]);
  });

  it("audit a completed task like any other call", async () => {
    const { run, callToolStream, audit, stored } = setup({ allowed: true });
    await run();
    await vi.waitFor(() => expect(stored).toHaveLength(1));

    expect(callToolStream).toHaveBeenCalledOnce();
    expect(stored[0].status).toBe("completed");
    expect(audit).toEqual([expect.objectContaining({ type: "tool_call", tool: "long_job", ok: true })]);
  });
});
