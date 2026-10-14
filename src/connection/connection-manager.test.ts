import { describe, it, expect, vi, beforeEach } from "vitest";
import type { CapabilityManifest } from "../sandbox/types.js";
import type { GatewayConfig } from "../config/types.js";

/**
 * A server that crashed used to come back from originalParams: no container,
 * no scoped environment — the sandboxed server restarted on the host with the
 * gateway's whole environment. These tests start a "sandboxed" server, crash it,
 * and look at what the reconnect launched.
 */

const createTransport = vi.hoisted(() => vi.fn());
vi.mock("./transport-factory.js", () => ({
  createTransport: (...a: unknown[]) => createTransport(...a),
}));
const resolveBakedImage = vi.hoisted(() => vi.fn());
vi.mock("../sandbox/container-runtime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../sandbox/container-runtime.js")>()),
  detectContainerEngine: async () => "docker",
  resolveBakedImage: (...a: unknown[]) => resolveBakedImage(...a),
}));

const { ConnectionManager } = await import("./connection-manager.js");

function fakeTransportResult() {
  return {
    client: { callTool: vi.fn(), close: vi.fn() },
    transport: { close: vi.fn(async () => {}) },
    serverInfo: { name: "fake", version: "1" },
    tools: [],
    resources: [],
    prompts: [],
  };
}

const mcpServer = {
  tool: vi.fn(() => ({ remove: vi.fn() })),
  sendToolListChanged: vi.fn(),
  sendResourceListChanged: vi.fn(),
  sendPromptListChanged: vi.fn(),
};

const config = {
  maxConnections: 5,
  proxyTimeoutMs: 1000,
  reconnectMaxAttempts: 3,
  reconnectBaseDelayMs: 1,
  enableAutoInstall: false,
  profilesPath: "unused",
} as unknown as GatewayConfig;

function manifest(network: CapabilityManifest["network"]): CapabilityManifest {
  return {
    version: 1,
    slug: "x",
    enforcement: "l2-container",
    env: { allow: [], inheritDefaults: true },
    network,
    filesystem: { read: [], write: [] },
    subprocess: false,
  };
}

function manager(m: CapabilityManifest) {
  const audit: Array<{ type: string; reason?: string }> = [];
  const cm = new ConnectionManager(
    mcpServer as never,
    {} as never,
    { isToolAllowed: () => true } as never,
    config,
  );
  cm.manifestResolver = { resolve: () => m } as never;
  cm.auditLog = { record: (e: { type: string; reason?: string }) => audit.push(e) } as never;
  return { cm, audit };
}

beforeEach(() => {
  createTransport.mockReset();
  createTransport.mockImplementation(async () => fakeTransportResult());
  resolveBakedImage.mockReset();
  resolveBakedImage.mockResolvedValue(null);
});

describe("network:none without a baked image", () => {
  it("refuses npx before spawning anything, since it could not fetch the package", async () => {
    const { cm } = manager(manifest({ mode: "none", allow: [] }));
    await expect(
      cm.connect({ command: "npx", args: ["-y", "some-server"], confirmed: true }),
    ).rejects.toThrow(/did not start it[\s\S]*build-server-image\.mjs --slug npx-some-server --package some-server/);
    expect(createTransport).not.toHaveBeenCalled();
    expect(cm.getConnection("npx-some-server")).toBeUndefined();
  });
});

describe("auto-reconnect", () => {
  it("restarts a crashed server inside the same container with the same scoped env", async () => {
    // Under network:none, npx only starts from a baked image.
    resolveBakedImage.mockResolvedValue({ image: "mcp-sandbox/npx-some-server:latest", bin: "some-server" });
    const { cm, audit } = manager(manifest({ mode: "none", allow: [] }));
    await cm.connect({ command: "npx", args: ["-y", "some-server"], confirmed: true });

    const first = createTransport.mock.calls[0][0];
    expect(first.command).toBe("docker");
    expect(first.args).toContain("--network");
    expect(first.preScopedEnv).toBeDefined();

    first.onClose(); // the process exits
    await vi.waitFor(() => expect(createTransport).toHaveBeenCalledTimes(2));

    const second = createTransport.mock.calls[1][0];
    expect(second.command).toBe(first.command);
    expect(second.args).toEqual(first.args);
    expect(second.preScopedEnv).toEqual(first.preScopedEnv);
    await vi.waitFor(() =>
      expect(audit.at(-1)?.reason).toMatch(/restarted after a crash \(attempt 1\) with the same launch/),
    );
    await cm.disconnect(first.slug, { removeProfile: false });
  });

  it("keeps the egress proxy URL — the same proxy — across a reconnect", async () => {
    const { cm } = manager(manifest({ mode: "allowlist", allow: ["example.com:443"] }));
    await cm.connect({ command: "npx", args: ["-y", "some-server"], confirmed: true });

    const first = createTransport.mock.calls[0][0];
    expect(first.preScopedEnv.HTTPS_PROXY).toMatch(/^http:\/\/mcp-gateway:[0-9a-f]{48}@host\.docker\.internal:\d+$/);
    expect(first.args.join(" ")).not.toContain(first.preScopedEnv.HTTPS_PROXY);

    first.onClose();
    await vi.waitFor(() => expect(createTransport).toHaveBeenCalledTimes(2));
    expect(createTransport.mock.calls[1][0].preScopedEnv.HTTPS_PROXY).toBe(first.preScopedEnv.HTTPS_PROXY);
    await cm.disconnect(first.slug, { removeProfile: false });
  });

  it("stops the egress proxy when the connect itself fails", async () => {
    const { cm } = manager(manifest({ mode: "allowlist", allow: ["example.com:443"] }));
    let proxyUrl = "";
    createTransport.mockImplementationOnce(async (p: { preScopedEnv: Record<string, string> }) => {
      proxyUrl = p.preScopedEnv.HTTPS_PROXY;
      throw new Error("handshake failed");
    });
    await expect(
      cm.connect({ command: "npx", args: ["-y", "some-server"], confirmed: true }),
    ).rejects.toThrow(/handshake failed/);

    const { port, username, password } = new URL(proxyUrl);
    const { request } = await import("node:http");
    const outcome = await new Promise<string>((resolve) => {
      const req = request({
        host: "127.0.0.1",
        port: Number(port),
        method: "CONNECT",
        path: "example.com:443",
        headers: {
          "Proxy-Authorization": "Basic " + Buffer.from(`${username}:${password}`).toString("base64"),
        },
      });
      req.on("connect", (res, s) => {
        s.destroy();
        resolve(`still listening (${res.statusCode})`);
      });
      req.on("error", (e: NodeJS.ErrnoException) => resolve(e.code ?? "error"));
      req.end();
    });
    expect(outcome).toBe("ECONNREFUSED");
  });
});

describe("connecting by registry name", () => {
  it("finds the server in whichever registry has it, and names the connection with a tool-safe slug", async () => {
    const { RegistryClient } = await import("../registry/registry-client.js");
    const { fromServerJson } = await import("../registry/sources/mcp-registry-source.js");
    const entry = {
      server: {
        name: "io.github.Acme/notes-mcp",
        packages: [{ registryType: "npm", identifier: "@acme/notes-mcp" }],
      },
    };
    const empty = { lastSuccessfulCall: null, lastError: null, cacheSize: 0 };
    const company = {
      label: "registry.acme.internal",
      kind: "mcp-registry" as const,
      search: async () => ({ data: [], total: 0, limit: 10, offset: 0 }),
      getServer: async () => null,
      getByName: async (name: string) => (name === entry.server.name ? fromServerJson(entry, "registry.acme.internal") : null),
      getStatus: () => empty,
      clearCache: () => {},
    };
    const cm = new ConnectionManager(
      mcpServer as never,
      new RegistryClient([company]),
      { isToolAllowed: () => true } as never,
      config,
    );

    const summary = await cm.connect({ slug: "io.github.Acme/notes-mcp", confirmed: true });

    expect(summary).toMatchObject({ slug: "io-github-acme-notes-mcp", trustTier: "unknown" });
    expect(createTransport.mock.calls[0][0]).toMatchObject({
      slug: "io-github-acme-notes-mcp",
      command: "npx",
      args: ["@acme/notes-mcp"],
    });
    await expect(cm.connect({ slug: "io.github.nobody/none", confirmed: true })).rejects.toThrow(
      /not found in registry\.acme\.internal/,
    );
    await cm.disconnect("io-github-acme-notes-mcp", { removeProfile: false });
  });
});

describe("a rating warning on connect", () => {
  it("stops for confirmation and says why, before anything starts", async () => {
    const { RegistryClient } = await import("../registry/registry-client.js");
    const warned = {
      id: "x", slug: "io-github-chromedevtools-chrome-devtools-mcp", name: "Chrome DevTools", description: null,
      author: null, repositoryUrl: null, npmPackage: "chrome-devtools-mcp-plus", homepage: null,
      installCommand: "npx chrome-devtools-mcp-plus", stars: null, weeklyDownloads: null, qualityScore: 90,
      isOfficial: false, isVerified: true, supportsDiscovery: false, discoveryUrl: null, category: null,
      tools: [], resources: [], metadata: null,
      trustWarning: "MCP Rating knows io.github.ChromeDevTools/chrome-devtools-mcp as npm:chrome-devtools-mcp; this registry's entry of that name runs npm:chrome-devtools-mcp-plus.",
    };
    const empty = { lastSuccessfulCall: null, lastError: null, cacheSize: 0 };
    const cm = new ConnectionManager(
      mcpServer as never,
      new RegistryClient([{
        label: "registry.acme.internal", kind: "mcp-registry",
        search: async () => ({ data: [], total: 0, limit: 10, offset: 0 }),
        getServer: async () => null, getByName: async () => warned,
        getStatus: () => empty, clearCache: () => {},
      }]),
      { isToolAllowed: () => true } as never,
      config,
    );

    // isVerified would make it [Verified] and skip confirmation — the warning still stops it.
    const result = await cm.connect({ slug: "io.github.ChromeDevTools/chrome-devtools-mcp" });
    expect(result).toMatchObject({ needsConfirmation: true });
    expect((result as { warning: string }).warning).toMatch(/^⚠️ MCP Rating knows io\.github\.ChromeDevTools\/chrome-devtools-mcp as npm:chrome-devtools-mcp/);
    expect(createTransport).not.toHaveBeenCalled();
  });
});
