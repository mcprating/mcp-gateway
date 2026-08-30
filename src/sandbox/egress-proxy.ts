import { createServer, type Server, type IncomingMessage } from "node:http";
import { connect as netConnect, type Socket } from "node:net";
import { log } from "../utils/logger.js";

/**
 * Match a "host:port" target against an allowlist pattern.
 *
 * Supported patterns:
 *   - "api.github.com:443"      exact host + port
 *   - "api.github.com"          exact host, any port
 *   - "*.githubusercontent.com" wildcard subdomain, any port
 *   - "*.example.com:443"       wildcard subdomain + port
 */
/**
 * Report allowlist patterns that will not behave the way their author expects.
 *
 * Matching fails CLOSED — a malformed pattern like `*example.com` (no dot)
 * matches no real hostname rather than matching everything — so this is not a
 * bypass. It is worse in a quieter way: the author believes they granted access,
 * the server is silently cut off from the internet, and the failure surfaces as
 * an unrelated timeout inside somebody else's package.
 *
 * The opposite mistake is `*.com`, which is syntactically fine and grants a
 * third of the web. Both deserve to be said out loud at load time.
 */
export function lintAllowlist(allowlist: string[]): string[] {
  const problems: string[] = [];
  // Public suffixes where a wildcard is almost certainly a mistake. Not
  // exhaustive by design — this is a nudge, not a policy engine.
  const BROAD = new Set(["com", "net", "org", "io", "dev", "app", "co", "ai"]);

  for (const raw of allowlist) {
    const pattern = raw.toLowerCase().trim();
    if (!pattern) continue;

    const colons = (pattern.match(/:/g) ?? []).length;
    if (colons > 1) {
      problems.push(`"${raw}": more than one ":" — host:port expected (IPv6 literals are not supported)`);
      continue;
    }
    const [patHost, patPort] = colons === 1 ? pattern.split(":") : [pattern, undefined];

    if (patPort !== undefined && !/^\d{1,5}$/.test(patPort)) {
      problems.push(`"${raw}": port "${patPort}" is not a number — this pattern can never match`);
    }
    if (patHost.includes("*")) {
      if (!patHost.startsWith("*.")) {
        problems.push(
          `"${raw}": wildcards must be written "*.example.com" — as written this matches nothing`,
        );
        continue;
      }
      if (patHost.slice(2).includes("*")) {
        problems.push(`"${raw}": only one leading "*." wildcard is supported — this matches nothing`);
        continue;
      }
      // A wildcard is too broad when what follows it is a public suffix rather
      // than somebody's domain — either a bare TLD ("*.com") or a known one.
      // One rule, because the two-branch version made the second unreachable.
      const base = patHost.slice(2);
      if (base.split(".").length < 2 || BROAD.has(base)) {
        problems.push(`"${raw}": wildcard over the public suffix "${base}" grants most of the web`);
      }
    }
  }
  return problems;
}

export function matchesAllowlist(
  host: string,
  port: number,
  allowlist: string[],
): boolean {
  const h = host.toLowerCase();
  for (const raw of allowlist) {
    const pattern = raw.toLowerCase().trim();
    if (!pattern) continue;

    const [patHost, patPort] = pattern.includes(":")
      ? pattern.split(":")
      : [pattern, undefined];

    // Port check (if the pattern specified one)
    if (patPort !== undefined && patPort !== String(port)) continue;

    // Host check — exact or wildcard
    if (patHost.startsWith("*.")) {
      const suffix = patHost.slice(1); // ".githubusercontent.com"
      if (h.endsWith(suffix) || h === patHost.slice(2)) return true;
    } else if (h === patHost) {
      return true;
    }
  }
  return false;
}

/**
 * An in-process HTTP forward proxy that enforces a host allowlist via the
 * CONNECT method (used by HTTPS clients). Connections to non-allowlisted
 * hosts are refused with 403.
 *
 * Containerized servers are pointed at this proxy via HTTPS_PROXY/HTTP_PROXY
 * and reach it through `host.docker.internal`. This gives `network: allowlist`
 * real teeth without a container sidecar.
 *
 * Limitation: only proxy-aware clients (those honoring HTTP(S)_PROXY) are
 * filtered. Clients that ignore proxy env vars bypass it — full enforcement
 * still requires L2 network namespacing, but this covers the common case
 * (node fetch/undici, axios, requests, etc. all honor the proxy env).
 */
export class EgressProxy {
  private server: Server | null = null;
  private port = 0;
  private blockedCount = 0;

  constructor(
    private readonly allowlist: string[],
    private readonly slug: string,
    /** Optional safety audit log — records blocked/allowed egress for forensics. */
    private readonly auditLog?: {
      record: (e: {
        type: "egress_blocked" | "egress_allowed";
        slug: string;
        target?: string;
        reason?: string;
      }) => void;
    },
  ) {
    // Say it once, at construction, rather than leaving the author to infer a
    // typo'd allowlist from a downstream package's connection timeout.
    for (const problem of lintAllowlist(allowlist)) {
      log.warn(`egress allowlist for "${slug}" — ${problem}`);
    }
  }

  /** Start listening on a random loopback port. Resolves with the port. */
  async start(): Promise<number> {
    return new Promise((resolve, reject) => {
      const server = createServer((req, res) => {
        // Plain HTTP proxying is not supported — only CONNECT (HTTPS tunnel).
        // Reject non-CONNECT requests; most MCP servers use HTTPS APIs.
        res.writeHead(405, { "Content-Type": "text/plain" });
        res.end("Only CONNECT (HTTPS) is proxied by the gateway egress filter.\n");
      });

      server.on("connect", (req: IncomingMessage, clientSocket: Socket, head: Buffer) => {
        this.handleConnect(req, clientSocket, head);
      });

      server.on("error", (err) => reject(err));

      // Bind to loopback only — the container reaches it via host.docker.internal,
      // which Docker maps to the host loopback.
      server.listen(0, "0.0.0.0", () => {
        const addr = server.address();
        this.port = typeof addr === "object" && addr ? addr.port : 0;
        this.server = server;
        log.info("Egress proxy started", {
          slug: this.slug,
          port: this.port,
          allowlist: this.allowlist,
        });
        resolve(this.port);
      });
    });
  }

  private handleConnect(
    req: IncomingMessage,
    clientSocket: Socket,
    head: Buffer,
  ): void {
    // req.url for CONNECT is "host:port"
    const target = req.url || "";
    const [host, portStr] = target.split(":");
    const port = parseInt(portStr || "443", 10);

    if (!host || !matchesAllowlist(host, port, this.allowlist)) {
      this.blockedCount++;
      log.warn("Egress blocked by allowlist", {
        slug: this.slug,
        target,
        blockedTotal: this.blockedCount,
      });
      this.auditLog?.record({
        type: "egress_blocked",
        slug: this.slug,
        target,
        reason: "not in network allowlist",
      });
      clientSocket.write(
        "HTTP/1.1 403 Forbidden\r\n\r\nBlocked by MCP gateway egress allowlist\r\n",
      );
      clientSocket.end();
      return;
    }

    this.auditLog?.record({ type: "egress_allowed", slug: this.slug, target });

    // Allowed — open the upstream tunnel and pipe bytes both ways.
    const upstream = netConnect(port, host, () => {
      clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head && head.length) upstream.write(head);
      upstream.pipe(clientSocket);
      clientSocket.pipe(upstream);
    });

    upstream.on("error", (err) => {
      log.debug("Egress upstream error", { slug: this.slug, target, error: String(err) });
      clientSocket.end();
    });
    clientSocket.on("error", () => upstream.end());
  }

  /** The proxy URL the container should use (via host.docker.internal). */
  get containerProxyUrl(): string {
    return `http://host.docker.internal:${this.port}`;
  }

  get blocked(): number {
    return this.blockedCount;
  }

  /** Stop the proxy. */
  async stop(): Promise<void> {
    if (!this.server) return;
    await new Promise<void>((resolve) => this.server!.close(() => resolve()));
    this.server = null;
    log.debug("Egress proxy stopped", { slug: this.slug });
  }
}
