import type { TransportType } from "./types.js";
import type { SpawnAndConnectResult } from "./downstream-client.js";
import { spawnAndConnect } from "./downstream-client.js";
import { connectViaSse } from "./sse-client.js";
import { connectViaWebSocket } from "./ws-client.js";
import { connectViaHttp } from "./http-client.js";

export interface CreateTransportParams {
  slug: string;
  transportType: TransportType;
  /** Required for stdio transport */
  command?: string;
  /** Required for stdio transport */
  args?: string[];
  /** Environment variables (stdio only) — user-supplied values */
  env?: Record<string, string>;
  /**
   * Pre-scoped environment from the sandbox manifest (stdio only). When set,
   * this is used as the child process environment verbatim, bypassing the
   * default inherit-and-merge behavior. This is how L1 env scoping is enforced.
   */
  preScopedEnv?: Record<string, string>;
  /** Required for SSE, WebSocket, and Streamable HTTP transports */
  url?: string;
  /** Called when the transport closes unexpectedly */
  onClose?: () => void;
  /** Called when the downstream tool list changes */
  onToolsChanged?: () => void;
  /** Timeout in ms for the entire connection (default: 30s) */
  connectionTimeoutMs?: number;
}

/**
 * Factory that creates the right transport client based on TransportType.
 * Returns a unified result shape regardless of transport.
 */
export async function createTransport(
  params: CreateTransportParams,
): Promise<SpawnAndConnectResult> {
  const { slug, transportType, onClose, onToolsChanged, connectionTimeoutMs } = params;

  switch (transportType) {
    case "stdio": {
      if (!params.command) {
        throw new Error(`Command is required for stdio transport (server: "${slug}")`);
      }
      return spawnAndConnect({
        slug,
        command: params.command,
        args: params.args || [],
        env: params.env,
        preScopedEnv: params.preScopedEnv,
        onClose,
        onToolsChanged,
        connectionTimeoutMs,
      });
    }

    case "sse": {
      if (!params.url) {
        throw new Error(`URL is required for SSE transport (server: "${slug}")`);
      }
      return connectViaSse({
        slug,
        url: params.url,
        onClose,
        onToolsChanged,
        connectionTimeoutMs,
      });
    }

    case "websocket": {
      if (!params.url) {
        throw new Error(`URL is required for WebSocket transport (server: "${slug}")`);
      }
      return connectViaWebSocket({
        slug,
        url: params.url,
        onClose,
        onToolsChanged,
        connectionTimeoutMs,
      });
    }

    case "streamable-http": {
      if (!params.url) {
        throw new Error(`URL is required for Streamable HTTP transport (server: "${slug}")`);
      }
      return connectViaHttp({
        slug,
        url: params.url,
        onClose,
        onToolsChanged,
        connectionTimeoutMs,
      });
    }

    default:
      throw new Error(`Unsupported transport type: "${transportType as string}"`);
  }
}
