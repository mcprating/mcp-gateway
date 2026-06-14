import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import type { SpawnAndConnectResult } from "./downstream-client.js";
import { connectClientAndFetchCapabilities, timeoutReject } from "./downstream-client.js";
import { log } from "../utils/logger.js";

/** Default timeout for SSE connection (30s) */
const SSE_CONNECTION_TIMEOUT_MS = 30_000;

export interface SseConnectParams {
  slug: string;
  url: string;
  onClose?: () => void;
  onToolsChanged?: () => void;
  connectionTimeoutMs?: number;
}

/**
 * Connect to a downstream MCP server via SSE transport.
 */
export async function connectViaSse(
  params: SseConnectParams,
): Promise<SpawnAndConnectResult> {
  const {
    slug,
    url,
    onClose,
    onToolsChanged,
    connectionTimeoutMs = SSE_CONNECTION_TIMEOUT_MS,
  } = params;

  log.info("Connecting via SSE", { slug, url });

  const result = await Promise.race([
    doSseConnect(slug, url, onClose, onToolsChanged),
    timeoutReject<SpawnAndConnectResult>(
      connectionTimeoutMs,
      `Timed out connecting to "${slug}" via SSE after ${connectionTimeoutMs}ms`,
    ),
  ]);

  return result;
}

async function doSseConnect(
  slug: string,
  url: string,
  onClose: (() => void) | undefined,
  onToolsChanged: (() => void) | undefined,
): Promise<SpawnAndConnectResult> {
  const transport = new SSEClientTransport(new URL(url));

  if (onClose) {
    transport.onclose = onClose;
  }

  const { client, serverInfo, tools, resources, prompts } =
    await connectClientAndFetchCapabilities(slug, transport, onToolsChanged);

  return { client, transport, tools, resources, prompts, serverInfo };
}
