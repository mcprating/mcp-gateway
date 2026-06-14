import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createGatewayServer, type GatewayContext } from "./gateway-server.js";
import { RegistryClient } from "./registry/registry-client.js";
import { ManifestResolver } from "./sandbox/manifest-resolver.js";
import type { GatewayConfig } from "./config/types.js";
import { log } from "./utils/logger.js";
import { dirname, join } from "node:path";

/** Per-session state held by the daemon. */
interface Session {
  id: string;
  /** Tenant that owns this session (for multi-tenant isolation). */
  tenant: string;
  transport: StreamableHTTPServerTransport;
  context: GatewayContext;
  createdAt: Date;
}

/**
 * Run the gateway as a long-running HTTP daemon.
 *
 * Multiple MCP clients connect over Streamable HTTP. Each gets its own
 * isolated session (McpServer + ConnectionManager + downstream connections),
 * but all sessions share a warm RegistryClient cache and a single Manifest
 * resolver (one source of truth for sandbox manifests on disk).
 *
 * Security: every /mcp request must carry `Authorization: Bearer <token>`.
 * The token is required in daemon mode regardless of bind address.
 *
 * Multi-tenant: supply `tokens` (tenantId → token) to run a shared daemon
 * where each tenant authenticates with its own token. Sessions are bound to
 * the authenticating tenant (cross-tenant session reuse is rejected), and each
 * tenant gets an isolated sandbox-manifest store. The single `token` maps to
 * tenant "default" for backward compatibility.
 */
export async function runHttpDaemon(
  config: GatewayConfig,
  opts: {
    port: number;
    host: string;
    token?: string;
    tokens?: Record<string, string>;
    allowedHosts?: string[];
    allowedOrigins?: string[];
  },
): Promise<void> {
  const { port, host } = opts;

  // Build the tenant → token map. The single token (if any) becomes "default".
  const tenantTokens: Record<string, string> = { ...(opts.tokens ?? {}) };
  if (opts.token) tenantTokens.default ??= opts.token;

  const tenantCount = Object.keys(tenantTokens).length;
  if (tenantCount === 0) {
    throw new Error(
      "HTTP daemon requires at least one auth token. Set MCP_GATEWAY_HTTP_TOKEN or MCP_GATEWAY_HTTP_TOKENS.",
    );
  }

  // Precompute the expected `Bearer <token>` header per tenant for matching.
  const expectedHeaders: Array<{ tenant: string; header: string }> = Object.entries(
    tenantTokens,
  ).map(([tenant, t]) => ({ tenant, header: `Bearer ${t}` }));

  // DNS-rebinding protection. If the operator didn't specify an allowlist,
  // default to localhost variants on the bind port — safe for local daemons.
  // When binding publicly (0.0.0.0 behind a domain), the operator should set
  // MCP_GATEWAY_HTTP_ALLOWED_HOSTS to the real hostname(s).
  const allowedHosts = new Set(
    (opts.allowedHosts ?? [
      `127.0.0.1:${port}`,
      `localhost:${port}`,
      `[::1]:${port}`,
    ]).map((h) => h.toLowerCase()),
  );
  const allowedOrigins = new Set(
    (opts.allowedOrigins ?? []).map((o) => o.toLowerCase()),
  );

  // Process-wide shared singleton: the registry cache holds public, read-only
  // data, so all tenants safely share one warm cache.
  const registryClient = new RegistryClient(
    config.registryApiUrl,
    config.registryCacheTtlMs,
    config.partnerKey,
  );

  // Sandbox manifests are tenant-private — one tenant must not see or alter
  // another's sandbox config. Each tenant gets its own resolver + file,
  // created lazily on first use.
  const manifestResolvers = new Map<string, ManifestResolver>();
  function manifestResolverFor(tenant: string): ManifestResolver {
    let r = manifestResolvers.get(tenant);
    if (!r) {
      const safe = tenant.replace(/[^a-z0-9_.-]/gi, "-").toLowerCase();
      const file =
        tenantCount === 1 && tenant === "default"
          ? join(dirname(config.permissionsPath), "mcp-gateway-manifests.json")
          : join(dirname(config.permissionsPath), `mcp-gateway-manifests-${safe}.json`);
      r = new ManifestResolver(file, config.enableContainerIsolation === true);
      manifestResolvers.set(tenant, r);
    }
    return r;
  }

  const sessions = new Map<string, Session>();

  /**
   * DNS-rebinding defense. Validates the Host header against the allowlist and
   * (if present) the Origin header against the origin allowlist. Browsers send
   * Origin; non-browser clients (agents, curl) don't — those pass the origin
   * check by design, but still must pass the Host check.
   *
   * Returns null if OK, or a short rejection reason string.
   */
  function checkHostOrigin(req: IncomingMessage): string | null {
    const hostHeader = req.headers["host"];
    const reqHost = Array.isArray(hostHeader) ? hostHeader[0] : hostHeader;
    if (!reqHost || !allowedHosts.has(reqHost.toLowerCase())) {
      return `Host "${reqHost ?? "(none)"}" not allowed`;
    }

    const originHeader = req.headers["origin"];
    const origin = Array.isArray(originHeader) ? originHeader[0] : originHeader;
    if (origin && !allowedOrigins.has(origin.toLowerCase())) {
      // An Origin header means a browser made this request. Reject unless
      // explicitly allowlisted — an agent daemon shouldn't take browser traffic.
      return `Origin "${origin}" not allowed`;
    }

    return null;
  }

  /** Constant-time-ish compare of two strings. */
  function safeEqual(a: string, b: string): boolean {
    if (a.length !== b.length) return false;
    let diff = 0;
    for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
    return diff === 0;
  }

  /**
   * Resolve the authenticating tenant from the bearer token. Compares against
   * every tenant token (constant-time per token) so the work doesn't reveal
   * which/how many tenants matched. Returns the tenant id, or null if no match.
   */
  function resolveTenant(req: IncomingMessage): string | null {
    const header = req.headers["authorization"];
    if (!header || Array.isArray(header)) return null;
    let matched: string | null = null;
    for (const { tenant, header: expected } of expectedHeaders) {
      if (safeEqual(header, expected)) matched = tenant;
    }
    return matched;
  }

  function sendJson(res: ServerResponse, status: number, body: unknown): void {
    const json = JSON.stringify(body);
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(json);
  }

  async function readBody(req: IncomingMessage): Promise<unknown> {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    if (chunks.length === 0) return undefined;
    try {
      return JSON.parse(Buffer.concat(chunks).toString("utf-8"));
    } catch {
      return undefined;
    }
  }

  function isInitialize(body: unknown): boolean {
    return (
      typeof body === "object" &&
      body !== null &&
      (body as { method?: string }).method === "initialize"
    );
  }

  async function createSession(tenant: string): Promise<Session> {
    // Build the session object first so the SDK callbacks can close over THIS
    // specific session — avoids any shared/pending-state race when multiple
    // clients initialize concurrently.
    const session = { id: "", tenant, createdAt: new Date() } as Session;

    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (sid: string) => {
        session.id = sid;
        sessions.set(sid, session);
        log.info("HTTP session initialized", {
          sessionId: sid,
          tenant,
          total: sessions.size,
        });
      },
      onsessionclosed: (sid: string) => {
        const s = sessions.get(sid);
        if (s) {
          s.context.connectionManager.disconnectAll().catch(() => {});
          sessions.delete(sid);
          log.info("HTTP session closed", {
            sessionId: sid,
            tenant: s.tenant,
            total: sessions.size,
          });
        }
      },
    });
    session.transport = transport;

    // Each session gets its own gateway context. The registry cache is shared;
    // the manifest store is the tenant's own (sandbox config stays private).
    const context = createGatewayServer(config, {
      registryClient,
      manifestResolver: manifestResolverFor(tenant),
    });
    session.context = context;
    await context.mcpServer.connect(transport);
    context.connectionManager.startHealthChecks();

    return session;
  }

  const server = createServer(async (req, res) => {
    const url = req.url || "/";

    // Health endpoint — unauthenticated, for liveness probes.
    if (url === "/health" || url === "/health/live") {
      return sendJson(res, 200, {
        status: "ok",
        sessions: sessions.size,
        uptime: process.uptime(),
      });
    }

    if (!url.startsWith("/mcp")) {
      return sendJson(res, 404, { error: "Not found" });
    }

    // DNS-rebinding protection: validate Host/Origin before anything else.
    const hostOriginError = checkHostOrigin(req);
    if (hostOriginError) {
      log.warn("Rejected request (host/origin)", { reason: hostOriginError });
      return sendJson(res, 403, {
        jsonrpc: "2.0",
        error: { code: -32002, message: `Forbidden: ${hostOriginError}` },
        id: null,
      });
    }

    // Auth: always required for /mcp. Resolves which tenant the token belongs to.
    const tenant = resolveTenant(req);
    if (!tenant) {
      res.setHeader("WWW-Authenticate", "Bearer");
      return sendJson(res, 401, {
        jsonrpc: "2.0",
        error: { code: -32001, message: "Unauthorized: missing or invalid bearer token" },
        id: null,
      });
    }

    const sessionId = req.headers["mcp-session-id"];
    const sid = Array.isArray(sessionId) ? sessionId[0] : sessionId;

    try {
      // Existing session → route to its transport, but only if the token's
      // tenant owns it (prevents cross-tenant session hijacking).
      if (sid && sessions.has(sid)) {
        const session = sessions.get(sid)!;
        if (session.tenant !== tenant) {
          log.warn("Rejected cross-tenant session access", {
            sessionId: sid,
            sessionTenant: session.tenant,
            requestTenant: tenant,
          });
          return sendJson(res, 403, {
            jsonrpc: "2.0",
            error: { code: -32003, message: "Forbidden: session belongs to another tenant" },
            id: null,
          });
        }
        const body = req.method === "POST" ? await readBody(req) : undefined;
        await session.transport.handleRequest(req, res, body);
        return;
      }

      // New session: only valid for an initialize POST without a session id.
      if (req.method === "POST") {
        const body = await readBody(req);
        if (!sid && isInitialize(body)) {
          const session = await createSession(tenant);
          await session.transport.handleRequest(req, res, body);
          return;
        }
        return sendJson(res, 400, {
          jsonrpc: "2.0",
          error: {
            code: -32000,
            message: sid
              ? "Unknown session id. Re-initialize."
              : "Missing session id (only initialize may omit it).",
          },
          id: null,
        });
      }

      // GET/DELETE without a known session.
      return sendJson(res, 400, {
        jsonrpc: "2.0",
        error: { code: -32000, message: "No active session for this request." },
        id: null,
      });
    } catch (err) {
      log.error("HTTP request handling failed", { error: String(err) });
      if (!res.headersSent) {
        sendJson(res, 500, {
          jsonrpc: "2.0",
          error: { code: -32603, message: "Internal error" },
          id: null,
        });
      }
    }
  });

  // Graceful shutdown.
  const shutdown = async () => {
    log.info("HTTP daemon shutting down", { sessions: sessions.size });
    for (const session of sessions.values()) {
      try {
        await session.context.connectionManager.disconnectAll();
        await session.context.mcpServer.close();
      } catch {
        /* best effort */
      }
    }
    sessions.clear();
    server.close(() => process.exit(0));
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  await new Promise<void>((resolve) => {
    server.listen(port, host, () => {
      log.info("MCP Gateway HTTP daemon listening", {
        url: `http://${host}:${port}/mcp`,
        health: `http://${host}:${port}/health`,
        authRequired: true,
        tenants: tenantCount,
      });
      resolve();
    });
  });
}
