import { describe, it, expect, afterEach } from "vitest";
import { createServer, type Server } from "node:net";
import { request } from "node:http";
import { EgressProxy, egressBindHost } from "./egress-proxy.js";
import { buildContainerCommand } from "./container-runtime.js";
import type { CapabilityManifest } from "./types.js";

/**
 * The proxy used to listen on 0.0.0.0 with no credential: anyone who could
 * reach the gateway host could tunnel through it to the allowlisted hosts, and
 * every such tunnel was audited as the sandboxed server's own traffic.
 */

type Audit = { type: string; target?: string; reason?: string };

/** CONNECT through the proxy as the container would, returning the status code. */
function connectThrough(
  proxyPort: number,
  target: string,
  proxyAuthorization?: string,
): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = request({
      host: "127.0.0.1",
      port: proxyPort,
      method: "CONNECT",
      path: target,
      headers: proxyAuthorization ? { "Proxy-Authorization": proxyAuthorization } : {},
    });
    req.on("connect", (res, socket) => {
      socket.destroy();
      resolve(res.statusCode ?? 0);
    });
    req.on("error", reject);
    req.end();
  });
}

/** The Proxy-Authorization a client derives from the URL's user:password. */
function authFromUrl(proxyUrl: string): string {
  const u = new URL(proxyUrl);
  const creds = `${decodeURIComponent(u.username)}:${decodeURIComponent(u.password)}`;
  return "Basic " + Buffer.from(creds).toString("base64");
}

let proxy: EgressProxy | undefined;
let upstream: Server | undefined;

afterEach(async () => {
  await proxy?.stop();
  upstream?.close();
  proxy = upstream = undefined;
});

/** A local "upstream" so the allowed case needs no internet. */
async function startUpstream(): Promise<number> {
  upstream = createServer((s) => s.end());
  await new Promise<void>((r) => upstream!.listen(0, "127.0.0.1", r));
  return (upstream.address() as { port: number }).port;
}

describe("EgressProxy credential", () => {
  it("tunnels to an allowlisted host only with the credential from its own URL", async () => {
    const upstreamPort = await startUpstream();
    const audit: Audit[] = [];
    proxy = new EgressProxy([`127.0.0.1:${upstreamPort}`], "s", { record: (e) => audit.push(e) });
    const port = await proxy.start();
    const target = `127.0.0.1:${upstreamPort}`;

    expect(await connectThrough(port, target, authFromUrl(proxy.containerProxyUrl))).toBe(200);
    expect(await connectThrough(port, target)).toBe(407);
    expect(await connectThrough(port, target, "Basic " + Buffer.from("mcp-gateway:guess").toString("base64"))).toBe(407);

    expect(audit.map((e) => e.type)).toEqual(["egress_allowed", "egress_blocked", "egress_blocked"]);
    expect(audit[1].reason).toMatch(/no valid proxy credential/);
  });

  it("still refuses a host outside the allowlist when the credential is right", async () => {
    proxy = new EgressProxy(["example.com:443"], "s");
    const port = await proxy.start();
    expect(await connectThrough(port, "evil.example.net:443", authFromUrl(proxy.containerProxyUrl))).toBe(403);
  });

  it("gives every proxy its own credential", () => {
    const a = new EgressProxy([], "a").containerProxyUrl;
    const b = new EgressProxy([], "b").containerProxyUrl;
    expect(new URL(a).password).toHaveLength(48);
    expect(new URL(a).password).not.toBe(new URL(b).password);
  });

  it("stops even with a tunnel open", async () => {
    const upstreamPort = await startUpstream();
    proxy = new EgressProxy([`127.0.0.1:${upstreamPort}`], "s");
    const port = await proxy.start();
    // Hold a tunnel open: resolve on connect without destroying the socket.
    await new Promise<void>((resolve) => {
      const req = request({
        host: "127.0.0.1",
        port,
        method: "CONNECT",
        path: `127.0.0.1:${upstreamPort}`,
        headers: { "Proxy-Authorization": authFromUrl(proxy!.containerProxyUrl) },
      });
      req.on("connect", () => resolve());
      req.end();
    });
    await proxy.stop(); // would hang before tunnels were tracked
    proxy = undefined;
  });
});

describe("egressBindHost", () => {
  it("listens on loopback where Docker Desktop forwards host.docker.internal to it", () => {
    expect(egressBindHost("docker", "win32")).toBe("127.0.0.1");
    expect(egressBindHost("docker", "darwin")).toBe("127.0.0.1");
  });

  it("listens on all interfaces where the container arrives on the bridge", () => {
    expect(egressBindHost("docker", "linux")).toBe("0.0.0.0");
    expect(egressBindHost("podman", "darwin")).toBe("0.0.0.0");
  });
});

describe("buildContainerCommand with an egress proxy", () => {
  const manifest = {
    version: 1,
    slug: "s",
    enforcement: "l2-container",
    env: { allow: [], inheritDefaults: true },
    network: { mode: "allowlist", allow: ["example.com:443"] },
    filesystem: { read: [], write: [] },
    subprocess: false,
  } as CapabilityManifest;

  it("forwards the proxy URL by name, keeping its credential off the command line", () => {
    const url = "http://mcp-gateway:s3cret@host.docker.internal:4321";
    const wrapped = buildContainerCommand("docker", manifest, "npx", ["-y", "pkg"], {
      egressProxyUrl: url,
    });
    expect(wrapped.args.join(" ")).not.toContain("s3cret");
    expect(wrapped.args).toContain("HTTPS_PROXY");
    expect(wrapped.env).toEqual({
      HTTPS_PROXY: url,
      HTTP_PROXY: url,
      https_proxy: url,
      http_proxy: url,
    });
    expect(wrapped.forwardedEnvNames).toEqual(
      expect.arrayContaining(["HTTPS_PROXY", "HTTP_PROXY", "https_proxy", "http_proxy"]),
    );
  });
});
