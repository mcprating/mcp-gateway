import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type {
  CreateTaskRequestHandlerExtra,
  TaskRequestHandlerExtra,
} from "@modelcontextprotocol/sdk/experimental/tasks/interfaces.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { buildPassthroughSchema } from "./schema-adapter.js";
import { TRUST_LABELS } from "../permissions/trust-tiers.js";
import type { DownstreamConnection, DownstreamTool } from "../connection/types.js";
import { log } from "../utils/logger.js";
import type { UsageTracker } from "../analytics/usage-tracker.js";
import type { AdTracker } from "../ads/ad-tracker.js";

const SEPARATOR = "__";

/**
 * Returns true if the downstream tool runs as an experimental MCP task
 * (taskSupport "optional" or "required"), meaning it must be proxied
 * through the task lifecycle rather than a plain `tools/call`.
 */
export function isTaskTool(tool: DownstreamTool): boolean {
  const support = tool.execution?.taskSupport;
  return support === "optional" || support === "required";
}

/**
 * Register a task-capable downstream tool on the gateway as an upstream
 * task-tool.
 *
 * Bridging model:
 *  - `createTask`: starts the downstream tool via `callToolStream`, creates a
 *    matching task in the gateway's upstream task store, and drives the
 *    downstream stream in the background — mirroring status updates and the
 *    final result/error into the upstream store.
 *  - `getTask` / `getTaskResult`: read straight from the upstream store, which
 *    the background loop keeps current. No manual task-ID mapping is needed
 *    because the upstream store owns the upstream task identity.
 *
 * Returns a `{ remove }` handle for cleanup, matching the plain-tool path.
 */
export function registerTaskProxyTool(
  mcpServer: McpServer,
  connection: DownstreamConnection,
  tool: DownstreamTool,
  proxyTimeoutMs: number,
  usageTracker?: UsageTracker,
  adTracker?: AdTracker | null,
): { remove: () => void } {
  const nsName = `${connection.slug}${SEPARATOR}${tool.name}`;
  const trustLabel = TRUST_LABELS[connection.trustTier];
  const description = `[${trustLabel}] [${connection.displayName}] [task] ${tool.description || tool.name}`;
  const inputSchema = buildPassthroughSchema(
    tool.inputSchema as Record<string, unknown>,
  );

  log.debug("Registering task-proxy tool", {
    nsName,
    downstream: tool.name,
    server: connection.slug,
    taskSupport: tool.execution?.taskSupport,
  });

  const registered = mcpServer.experimental.tasks.registerToolTask(
    nsName,
    {
      description,
      inputSchema,
      // Mirror the downstream requirement: if the downstream demands a task,
      // require it upstream too; otherwise allow either.
      execution: {
        taskSupport:
          tool.execution?.taskSupport === "required" ? "required" : "optional",
      },
    },
    {
      // ── Create: kick off downstream work, mirror into upstream store ──
      createTask: async (
        args: Record<string, unknown>,
        extra: CreateTaskRequestHandlerExtra,
      ) => {
        const startedAt = Date.now();

        const task = await extra.taskStore.createTask({
          ttl: extra.taskRequestedTtl ?? 300_000,
        });

        log.debug("Task created, starting downstream stream", {
          nsName,
          taskId: task.taskId,
        });

        // Drive the downstream task in the background. We intentionally do
        // not await — createTask must return promptly with the task handle.
        void driveDownstreamTask({
          connection,
          tool,
          args,
          upstreamTaskId: task.taskId,
          taskStore: extra.taskStore,
          proxyTimeoutMs,
          startedAt,
          usageTracker,
          adTracker,
        });

        return { task };
      },

      // ── Get task status: read from upstream store ──
      getTask: async (
        _args: Record<string, unknown>,
        extra: TaskRequestHandlerExtra,
      ) => {
        return extra.taskStore.getTask(extra.taskId);
      },

      // ── Get task result: read from upstream store ──
      getTaskResult: async (
        _args: Record<string, unknown>,
        extra: TaskRequestHandlerExtra,
      ) => {
        const result = await extra.taskStore.getTaskResult(extra.taskId);
        return result as CallToolResult;
      },
    },
  );

  return { remove: () => registered.remove() };
}

/**
 * Background driver: consumes the downstream task stream and mirrors its
 * lifecycle into the gateway's upstream task store. Never throws — all
 * failures are converted into a stored "failed" result so upstream getters
 * always resolve.
 */
async function driveDownstreamTask(opts: {
  connection: DownstreamConnection;
  tool: DownstreamTool;
  args: Record<string, unknown>;
  upstreamTaskId: string;
  taskStore: CreateTaskRequestHandlerExtra["taskStore"];
  proxyTimeoutMs: number;
  startedAt: number;
  usageTracker?: UsageTracker;
  adTracker?: AdTracker | null;
}): Promise<void> {
  const {
    connection,
    tool,
    args,
    upstreamTaskId,
    taskStore,
    startedAt,
    usageTracker,
    adTracker,
  } = opts;

  try {
    const stream = connection.client.experimental.tasks.callToolStream({
      name: tool.name,
      arguments: args,
    });

    for await (const message of stream) {
      switch (message.type) {
        case "taskStatus":
          // Mirror non-terminal status (working / input_required) upstream.
          if (
            message.task.status === "working" ||
            message.task.status === "input_required"
          ) {
            await taskStore
              .updateTaskStatus(upstreamTaskId, message.task.status, message.task.statusMessage)
              .catch(() => {});
          }
          break;

        case "result": {
          await taskStore.storeTaskResult(
            upstreamTaskId,
            "completed",
            message.result,
          );
          recordUsage(usageTracker, connection, tool, startedAt, true);
          if (adTracker) {
            adTracker.trackToolUsage(connection.slug, tool.name).catch(() => {});
          }
          return;
        }

        case "error": {
          const errMsg = message.error?.message ?? "Downstream task failed";
          await taskStore.storeTaskResult(upstreamTaskId, "failed", {
            content: [
              {
                type: "text",
                text: `Error from ${connection.displayName}: ${errMsg}`,
              },
            ],
            isError: true,
          });
          recordUsage(usageTracker, connection, tool, startedAt, false, errMsg);
          return;
        }

        // "taskCreated" — downstream task started; nothing to mirror since the
        // upstream task already exists. Continue consuming the stream.
        default:
          break;
      }
    }

    // Stream ended without an explicit result/error message — treat as failure
    // so upstream getters never hang on a missing result.
    await taskStore
      .storeTaskResult(upstreamTaskId, "failed", {
        content: [
          {
            type: "text",
            text: `Downstream task for ${tool.name} ended without a result.`,
          },
        ],
        isError: true,
      })
      .catch(() => {});
    recordUsage(usageTracker, connection, tool, startedAt, false, "no result");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error("Downstream task stream failed", {
      slug: connection.slug,
      tool: tool.name,
      error: msg,
    });
    await taskStore
      .storeTaskResult(upstreamTaskId, "failed", {
        content: [
          {
            type: "text",
            text: `Error from ${connection.displayName}: ${msg}`,
          },
        ],
        isError: true,
      })
      .catch(() => {});
    recordUsage(usageTracker, connection, tool, startedAt, false, msg);
  }
}

function recordUsage(
  usageTracker: UsageTracker | undefined,
  connection: DownstreamConnection,
  tool: DownstreamTool,
  startedAt: number,
  success: boolean,
  error?: string,
): void {
  if (!usageTracker) return;
  usageTracker.recordCall({
    slug: connection.slug,
    toolName: tool.name,
    startedAt,
    durationMs: Date.now() - startedAt,
    success,
    ...(error ? { error } : {}),
  });
}
