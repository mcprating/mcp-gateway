import { describe, it, expect } from "vitest";
import { RegistryClient } from "./registry-client.js";
import { registerDiscover } from "../meta-tools/discover.js";
import type { RegistryServer } from "./types.js";

const client = new RegistryClient("https://registry.invalid/api/v1");
const everything = () => true;
const nothing = () => false;

function server(overrides: Partial<RegistryServer> & { slug: string }): RegistryServer {
  return {
    id: overrides.slug,
    name: overrides.slug,
    description: null,
    npmPackage: null,
    installCommand: null,
    repositoryUrl: null,
    metadata: null,
    qualityScore: 50,
    ...overrides,
  } as RegistryServer;
}

const tried = (latestOutcome: string, lastAttemptedAt = "2026-09-16T03:57:11Z") =>
  ({ latestOutcome, lastAttemptedAt, lastVerifiedAt: null, attemptCount: 1, verifiedCount: latestOutcome === "verified" ? 1 : 0 });

describe("resolveRemote", () => {
  it("returns the first http(s) endpoint and its transport", () => {
    const s = server({ slug: "r", metadata: { remotes: [{ url: "https://mcp.example.com/sse", type: "sse" }] } });
    expect(client.resolveRemote(s)).toEqual({ url: "https://mcp.example.com/sse", transportType: "sse", requiredHeaders: [] });
  });

  // Registry data is written by strangers; only http(s) may reach a transport.
  it("skips non-http endpoints", () => {
    const s = server({
      slug: "r",
      metadata: { remotes: [{ url: "javascript:alert(1)" }, { url: "file:///etc/passwd" }, { url: "http://ok.example/mcp" }] },
    });
    expect(client.resolveRemote(s)?.url).toBe("http://ok.example/mcp");
  });

  it("reports headers the endpoint requires", () => {
    const s = server({
      slug: "r",
      metadata: { remotes: [{ url: "https://x.example/mcp", type: "streamable-http", headers: [{ name: "Authorization", isRequired: true }, { name: "X-Optional" }] }] },
    });
    expect(client.resolveRemote(s)?.requiredHeaders).toEqual(["Authorization"]);
  });
});

describe("readiness", () => {
  it("is ready for an installable server that declares no keys", () => {
    expect(client.readiness(server({ slug: "a", npmPackage: "a" }), {}, nothing).level).toBe("ready");
  });

  it("needs setup when a declared key is missing, and names it", () => {
    const s = server({ slug: "exa", installCommand: "npx exa-mcp-server", authDetails: { envVars: [{ name: "EXA_API_KEY" }] } } as never);
    expect(client.readiness(s, {}, everything)).toMatchObject({ level: "needs-setup", missing: ["EXA_API_KEY"] });
    expect(client.readiness(s, { EXA_API_KEY: "set" }, everything).level).toBe("ready");
  });

  // uvx isn't on this machine: the 0.2.4 connect fails with "install uv".
  it("needs setup when the launcher isn't installed here", () => {
    const s = server({ slug: "py", installCommand: "uvx websearch-skill" });
    expect(client.readiness(s, {}, nothing)).toMatchObject({ level: "needs-setup", missing: ["uvx"] });
    expect(client.readiness(s, {}, everything).level).toBe("ready");
  });

  it("is ready for a keyless hosted server, via its endpoint", () => {
    const s = server({ slug: "h", metadata: { remotes: [{ url: "https://mcp.example.com", type: "streamable-http" }] } });
    expect(client.readiness(s, {}, nothing)).toMatchObject({ level: "ready", via: "remote" });
  });

  it("needs setup for a hosted server that requires a header", () => {
    const s = server({ slug: "h", metadata: { remotes: [{ url: "https://mcp.example.com", headers: [{ name: "Authorization", isSecret: true }] }] } });
    expect(client.readiness(s, {}, nothing)).toMatchObject({ level: "needs-setup", via: "remote", missing: ["Authorization"] });
  });

  // Our own test outranks metadata.
  it("marks a server that failed to start in our test", () => {
    const s = server({ slug: "f", npmPackage: "f", verification: tried("failed_to_start") });
    expect(client.readiness(s, {}, everything).level).toBe("failed-in-test");
  });

  it("treats our test's needs_credentials as setup needed, even with no declared key", () => {
    const s = server({ slug: "c", npmPackage: "c", verification: tried("needs_credentials") });
    expect(client.readiness(s, {}, everything).level).toBe("needs-setup");
  });

  it("records a verified start", () => {
    const s = server({ slug: "v", npmPackage: "v", verification: tried("verified") });
    expect(client.readiness(s, {}, everything)).toMatchObject({ level: "ready", verified: true });
  });

  it("is not runnable with no install command and no endpoint", () => {
    expect(client.readiness(server({ slug: "gh", repositoryUrl: "https://github.com/x/y" }), {}, everything).level).toBe("not-runnable");
  });
});

describe("mcp_discover ordering", () => {
  async function discover(data: RegistryServer[], limit?: number): Promise<string> {
    let handler: ((args: Record<string, unknown>) => Promise<{ content: Array<{ text: string }> }>) | undefined;
    const fakeServer = { tool: (_n: string, _d: string, _s: unknown, h: typeof handler) => { handler = h; } };
    const fakeClient = Object.assign(Object.create(RegistryClient.prototype), client, {
      search: async () => ({ data, total: data.length }),
    });
    registerDiscover(fakeServer as never, fakeClient as RegistryClient);
    return (await handler!({ query: "web search", limit })).content[0].text;
  }
  const slugs = (text: string) => [...text.matchAll(/\*\*Slug:\*\* `([^`]+)`/g)].map((m) => m[1]);

  // The 8B's four-in-five failure: the top two results had nothing to spawn,
  // and the installable ones below had already failed to start in our test.
  it("orders by what the gateway can start: verified, untested, setup, failed in test, not runnable", async () => {
    const text = await discover([
      server({ slug: "exa-labs-exa-mcp-server", repositoryUrl: "https://github.com/exa-labs/exa-mcp-server" }),
      server({ slug: "failed", npmPackage: "failed", verification: tried("failed_to_start") }),
      server({ slug: "needs-key", npmPackage: "needs-key", authDetails: { envVars: [{ name: "ZZ_TEST_KEY_UNSET" }] } } as never),
      server({ slug: "untested", npmPackage: "untested" }),
      server({ slug: "hosted", metadata: { remotes: [{ url: "https://mcp.example.com" }] } }),
      server({ slug: "verified", npmPackage: "verified", verification: tried("verified") }),
    ]);
    expect(slugs(text)).toEqual(["verified", "untested", "hosted", "needs-key", "failed", "exa-labs-exa-mcp-server"]);
  });

  it("shows our test's evidence, and says nothing for a server never attempted", async () => {
    const text = await discover([
      server({ slug: "failed", npmPackage: "failed", verification: tried("failed_to_start", "2026-09-16T03:57:11Z") }),
      server({ slug: "untested", npmPackage: "untested" }),
    ]);
    expect(text).toContain("✗ Didn't start in our test (2026-09-16, no credentials given).");
    const untestedBlock = text.split("\n### ").find((b) => b.startsWith("untested"))!;
    expect(untestedBlock).toBeDefined();
    expect(untestedBlock).not.toMatch(/our test/);
  });

  it("never suggests passing a key through mcp_connect", async () => {
    const text = await discover([server({ slug: "needs-key", npmPackage: "x", authDetails: { envVars: [{ name: "ZZ_TEST_KEY_UNSET" }] } } as never)]);
    expect(text).not.toMatch(/env:\s*\{/);
    expect(text).toContain("gateway's env in the MCP client config");
  });

  it("does not offer a slug connect for a server it can't start", async () => {
    const text = await discover([server({ slug: "gh-only", repositoryUrl: "https://github.com/x/y" })]);
    expect(text).toContain("can't connect by slug");
    expect(text).not.toContain('mcp_connect({slug: "gh-only"})');
  });

  it("returns only the requested number after re-ordering", async () => {
    const data = Array.from({ length: 12 }, (_, i) => server({ slug: `s${i}`, npmPackage: `p${i}` }));
    const text = await discover(data, 5);
    expect(slugs(text).length).toBe(5);
  });
});
