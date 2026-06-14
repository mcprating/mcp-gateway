import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { SpawnAndConnectResult } from "./downstream-client.js";
import { connectClientAndFetchCapabilities, timeoutReject } from "./downstream-client.js";
import { log } from "../utils/logger.js";

/** Default timeout for Streamable HTTP connection (30s) */
const HTTP_CONNECTION_TIMEOUT_MS = 30_000;

export interface HttpConnectParams {
  slug: string;
  url: string;
  onClose?: () => void;
  onToolsChanged?: () => void;
  connectionTimeoutMs?: number;
}

/**
 * Connect to a downstream MCP server via Streamable HTTP transport.
 */
export async function connectViaHttp(
  params: HttpConnectParams,
): Promise<SpawnAndConnectResult> {
  const {
    slug,
    url,
    onClose,
    onToolsChanged,
    connectionTimeoutMs = HTTP_CONNECTION_TIMEOUT_MS,
  } = params;

  log.info("Connecting via Streamable HTTP", { slug, url });

  const result = await Promise.race([
    doHttpConnect(slug, url, onClose, onToolsChanged),
    timeoutReject<SpawnAndConnectResult>(
      connectionTimeoutMs,
      `Timed out connecting to "${slug}" via Streamable HTTP after ${connectionTimeoutMs}ms`,
    ),
  ]);

  return result;
}

async function doHttpConnect(
  slug: string,
  url: string,
  onClose: (() => void) | undefined,
  onToolsChanged: (() => void) | undefined,
): Promise<SpawnAndConnectResult> {
  const transport = new StreamableHTTPClientTransport(new URL(url));

  if (onClose) {
    transport.onclose = onClose;
  }

  const { client, serverInfo, tools, resources, prompts } =
    await connectClientAndFetchCapabilities(slug, transport, onToolsChanged);

  return { client, transport, tools, resources, prompts, serverInfo };
}
