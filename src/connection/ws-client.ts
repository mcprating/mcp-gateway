import { WebSocketClientTransport } from "@modelcontextprotocol/sdk/client/websocket.js";
import type { SpawnAndConnectResult } from "./downstream-client.js";
import { connectClientAndFetchCapabilities, timeoutReject } from "./downstream-client.js";
import { log } from "../utils/logger.js";

/** Default timeout for WebSocket connection (30s) */
const WS_CONNECTION_TIMEOUT_MS = 30_000;

export interface WsConnectParams {
  slug: string;
  url: string;
  onClose?: () => void;
  onToolsChanged?: () => void;
  connectionTimeoutMs?: number;
}

/**
 * Connect to a downstream MCP server via WebSocket transport.
 */
export async function connectViaWebSocket(
  params: WsConnectParams,
): Promise<SpawnAndConnectResult> {
  const {
    slug,
    url,
    onClose,
    onToolsChanged,
    connectionTimeoutMs = WS_CONNECTION_TIMEOUT_MS,
  } = params;

  log.info("Connecting via WebSocket", { slug, url });

  const result = await Promise.race([
    doWsConnect(slug, url, onClose, onToolsChanged),
    timeoutReject<SpawnAndConnectResult>(
      connectionTimeoutMs,
      `Timed out connecting to "${slug}" via WebSocket after ${connectionTimeoutMs}ms`,
    ),
  ]);

  return result;
}

async function doWsConnect(
  slug: string,
  url: string,
  onClose: (() => void) | undefined,
  onToolsChanged: (() => void) | undefined,
): Promise<SpawnAndConnectResult> {
  const transport = new WebSocketClientTransport(new URL(url));

  if (onClose) {
    transport.onclose = onClose;
  }

  const { client, serverInfo, tools, resources, prompts } =
    await connectClientAndFetchCapabilities(slug, transport, onToolsChanged);

  return { client, transport, tools, resources, prompts, serverInfo };
}
