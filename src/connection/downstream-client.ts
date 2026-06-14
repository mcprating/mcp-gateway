import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  StdioClientTransport,
  getDefaultEnvironment,
} from "@modelcontextprotocol/sdk/client/stdio.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { DownstreamTool, DownstreamResource, DownstreamPrompt } from "./types.js";
import { log } from "../utils/logger.js";

/** Default timeout for the initial connection + handshake + tool fetch (30s) */
const CONNECTION_TIMEOUT_MS = 30_000;

export interface SpawnAndConnectParams {
  slug: string;
  command: string;
  args: string[];
  env?: Record<string, string>;
  /**
   * Sandbox-scoped environment (L1). When provided, used as the child's
   * environment verbatim — bypasses the inherit-defaults + merge behavior.
   */
  preScopedEnv?: Record<string, string>;
  onClose?: () => void;
  onToolsChanged?: () => void;
  /** Timeout in ms for the entire spawn + handshake + tool fetch. Default: 30s */
  connectionTimeoutMs?: number;
}

export interface SpawnAndConnectResult {
  client: Client;
  transport: Transport;
  tools: DownstreamTool[];
  resources: DownstreamResource[];
  prompts: DownstreamPrompt[];
  serverInfo?: { name: string; version: string };
}

/**
 * Spawn a downstream MCP server as a child process, connect to it
 * via StdioClientTransport, and fetch its tool, resource, and prompt lists.
 */
export async function spawnAndConnect(
  params: SpawnAndConnectParams,
): Promise<SpawnAndConnectResult> {
  const {
    slug,
    command,
    args,
    env,
    preScopedEnv,
    onClose,
    onToolsChanged,
    connectionTimeoutMs = CONNECTION_TIMEOUT_MS,
  } = params;

  log.info("Spawning downstream server", { slug, command, args });

  // Race the entire spawn+handshake+toolFetch against a timeout
  const result = await Promise.race([
    doSpawnAndConnect(slug, command, args, env, onClose, onToolsChanged, preScopedEnv),
    timeoutReject<SpawnAndConnectResult>(
      connectionTimeoutMs,
      `Timed out connecting to "${slug}" after ${connectionTimeoutMs}ms`,
    ),
  ]);

  return result;
}

async function doSpawnAndConnect(
  slug: string,
  command: string,
  args: string[],
  env: Record<string, string> | undefined,
  onClose: (() => void) | undefined,
  onToolsChanged: (() => void) | undefined,
  preScopedEnv?: Record<string, string>,
): Promise<SpawnAndConnectResult> {
  // Environment resolution:
  //  - If the caller provided a sandbox-scoped env (L1), use it verbatim.
  //    It already includes safe defaults + allowlisted + user vars.
  //  - Otherwise fall back to legacy behavior: safe defaults + user overrides.
  const mergedEnv = preScopedEnv
    ? preScopedEnv
    : env
      ? { ...getDefaultEnvironment(), ...env }
      : getDefaultEnvironment();

  // Auto-add -y flag to npx commands for auto-install
  let finalArgs = args;
  if (command === "npx" && !args.includes("-y") && !args.includes("--yes")) {
    finalArgs = ["-y", ...args];
  }

  const transport = new StdioClientTransport({
    command,
    args: finalArgs,
    env: mergedEnv,
    stderr: "pipe", // Capture stderr for diagnostics
  });

  // Pipe downstream stderr to our logger
  const stderrStream = transport.stderr;
  if (stderrStream) {
    stderrStream.on("data", (chunk: Buffer) => {
      const text = chunk.toString().trim();
      if (text) {
        log.debug(`[${slug}] stderr: ${text}`);
      }
    });
  }

  // Set up close handler for process crash detection
  if (onClose) {
    transport.onclose = onClose;
  }

  const { client, serverInfo, tools, resources, prompts } =
    await connectClientAndFetchCapabilities(slug, transport, onToolsChanged);

  return {
    client,
    transport,
    tools,
    resources,
    prompts,
    serverInfo,
  };
}

// ── Shared client setup ──────────────────────────────────────────────────────

export interface ConnectAndFetchResult {
  client: Client;
  serverInfo?: { name: string; version: string };
  tools: DownstreamTool[];
  resources: DownstreamResource[];
  prompts: DownstreamPrompt[];
}

/**
 * Create an MCP client, connect it to a transport, and fetch all capabilities.
 * This is shared by all transport types (stdio, SSE, WebSocket, Streamable HTTP).
 */
export async function connectClientAndFetchCapabilities(
  slug: string,
  transport: Transport,
  onToolsChanged?: (() => void) | undefined,
): Promise<ConnectAndFetchResult> {
  // Create MCP client with tool list change tracking
  const client = new Client(
    { name: "mcp-gateway", version: "0.1.0" },
    {
      capabilities: {},
      listChanged: onToolsChanged
        ? {
            tools: {
              onChanged: (error, tools) => {
                if (error) {
                  log.warn(`[${slug}] Tool list refresh failed`, {
                    error: String(error),
                  });
                  return;
                }
                log.info(`[${slug}] Tool list changed`, {
                  toolCount: Array.isArray(tools) ? tools.length : 0,
                });
                onToolsChanged();
              },
            },
          }
        : undefined,
    },
  );

  // Connect and perform MCP handshake
  await client.connect(transport);

  const serverVersion = client.getServerVersion();
  const serverInfo = serverVersion
    ? { name: serverVersion.name, version: serverVersion.version }
    : undefined;

  log.info("Connected to downstream server", {
    slug,
    serverName: serverInfo?.name,
    serverVersion: serverInfo?.version,
  });

  // Fetch tool list
  const toolsResponse = await client.listTools();
  const tools: DownstreamTool[] = toolsResponse.tools.map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: t.inputSchema as Record<string, unknown>,
    annotations: t.annotations as Record<string, unknown> | undefined,
    execution: (t as { execution?: { taskSupport?: "optional" | "required" | "forbidden" } })
      .execution,
    _meta: (t as { _meta?: Record<string, unknown> })._meta,
  }));

  log.info("Fetched downstream tools", {
    slug,
    toolCount: tools.length,
    toolNames: tools.map((t) => t.name),
  });

  // Fetch resources (gracefully handle servers that don't support resources)
  let resources: DownstreamResource[] = [];
  try {
    const resourcesResponse = await client.listResources();
    resources = resourcesResponse.resources.map((r) => ({
      uri: r.uri,
      name: r.name,
      description: r.description,
      mimeType: r.mimeType,
    }));
    if (resources.length > 0) {
      log.info("Fetched downstream resources", {
        slug,
        resourceCount: resources.length,
      });
    }
  } catch {
    log.debug("Server does not support resources", { slug });
  }

  // Fetch prompts (gracefully handle servers that don't support prompts)
  let prompts: DownstreamPrompt[] = [];
  try {
    const promptsResponse = await client.listPrompts();
    prompts = promptsResponse.prompts.map((p) => ({
      name: p.name,
      description: p.description,
      arguments: p.arguments?.map((a) => ({
        name: a.name,
        description: a.description,
        required: a.required,
      })),
    }));
    if (prompts.length > 0) {
      log.info("Fetched downstream prompts", {
        slug,
        promptCount: prompts.length,
      });
    }
  } catch {
    log.debug("Server does not support prompts", { slug });
  }

  return { client, serverInfo, tools, resources, prompts };
}

// ── Helpers ──────────────────────────────────────────────────────────────────

export function timeoutReject<T>(ms: number, message: string): Promise<T> {
  return new Promise<T>((_, reject) => {
    setTimeout(() => reject(new Error(message)), ms);
  });
}
