import { log } from "../utils/logger.js";

/**
 * Progress notification from the downstream server's onprogress callback.
 * Matches the MCP `notifications/progress` params shape (without progressToken,
 * which the forwarder adds).
 */
export interface DownstreamProgress {
  progress: number;
  total?: number;
  message?: string;
}

/**
 * Minimal slice of the upstream `RequestHandlerExtra` we need to forward
 * progress notifications back to the original client. Typed loosely so we
 * stay compatible with future MCP SDK changes to `RequestHandlerExtra`.
 */
export interface UpstreamProgressContext {
  _meta?: { progressToken?: string | number } | undefined;
  sendNotification: (notification: {
    method: "notifications/progress";
    params: {
      progressToken: string | number;
      progress: number;
      total?: number;
      message?: string;
    };
  }) => Promise<void>;
}

/**
 * Build an `onprogress` callback that relays downstream progress events back
 * to the upstream client using the upstream-supplied `progressToken`.
 *
 * Returns `undefined` when the upstream client didn't supply a progress
 * token — in which case we skip the wiring entirely so the SDK doesn't
 * allocate handlers we'll never invoke.
 *
 * Failures inside the forwarder are logged but never thrown — progress
 * notifications are best-effort by design.
 */
export function buildProgressForwarder(
  extra: UpstreamProgressContext | undefined,
  context: { slug: string; toolName: string },
): ((progress: DownstreamProgress) => void) | undefined {
  const upstreamToken = extra?._meta?.progressToken;
  if (upstreamToken === undefined || !extra?.sendNotification) {
    return undefined;
  }

  return (progress: DownstreamProgress): void => {
    extra
      .sendNotification({
        method: "notifications/progress",
        params: {
          progressToken: upstreamToken,
          progress: progress.progress,
          total: progress.total,
          message: progress.message,
        },
      })
      .catch((err: unknown) => {
        // Best-effort: don't fail the tool call if a progress notification
        // can't be delivered (e.g. transport already closed).
        log.warn("Failed to forward progress notification", {
          slug: context.slug,
          toolName: context.toolName,
          error: err instanceof Error ? err.message : String(err),
        });
      });
  };
}
