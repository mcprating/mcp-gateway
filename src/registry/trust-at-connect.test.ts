import { describe, it, expect, vi, afterEach } from "vitest";
import { launchKeys } from "./launch-keys.js";
import { trustLines, maintenanceFacts, startTestLine, type TrustFacts } from "./trust-facts.js";
import { RegistryClient } from "./registry-client.js";
import { McpRatingSource } from "./sources/mcprating-source.js";
import { parseMinScore } from "../config/gateway-config.js";
import type { RegistryServer } from "./types.js";

afterEach(() => vi.unstubAllGlobals());

describe("launchKeys: the package an explicit launch would run", () => {
  it("reads npx past its own options, and drops the version", () => {
    expect(launchKeys({ command: "npx", args: ["-y", "@modelcontextprotocol/server-everything@2.0.0"] })).toEqual([
      "npm:@modelcontextprotocol/server-everything",
    ]);
    expect(launchKeys({ command: "npx", args: ["--package", "@clize/inbox", "clize-mcp"] })).toEqual(["npm:@clize/inbox"]);
    expect(launchKeys({ command: "C:\\Program Files\\nodejs\\npx.cmd", args: ["chrome-devtools-mcp@latest"] })).toEqual([
      "npm:chrome-devtools-mcp",
    ]);
  });

  it("reads uvx (and uv tool run) past options and their values, without extras or version", () => {
    expect(launchKeys({ command: "uvx", args: ["-p", "3.13", "serena-agent", "start-mcp-server"] })).toEqual(["pypi:serena-agent"]);
    expect(launchKeys({ command: "uvx", args: ["--from", "Gamewave_Unreal-MCP", "unreal-mcp"] })).toEqual(["pypi:gamewave-unreal-mcp"]);
    expect(launchKeys({ command: "uvx", args: ["scrapling[ai]==0.4.15", "mcp"] })).toEqual(["pypi:scrapling"]);
    expect(launchKeys({ command: "uv", args: ["tool", "run", "mcp-server-fetch"] })).toEqual(["pypi:mcp-server-fetch"]);
  });

  it("finds the image in docker run, past options that take values", () => {
    expect(
      launchKeys({ command: "docker", args: ["run", "-i", "--rm", "-e", "GITHUB_TOKEN", "-v", "/a:/b", "mcp/github:latest", "--stdio"] }),
    ).toEqual(["oci:mcp/github"]);
    expect(launchKeys({ command: "docker", args: ["run", "--rm", "--network=none", "ghcr.io/acme/mcp:1"] })).toEqual([
      "oci:ghcr.io/acme/mcp",
    ]);
  });

  it("keys a URL by its endpoint, and gives nothing for a launch that runs no named package", () => {
    expect(launchKeys({ url: "https://MCP.example.com/mcp/" })).toEqual(["remote:https://mcp.example.com/mcp"]);
    expect(launchKeys({ command: "node", args: ["./server.js"] })).toEqual([]);
    expect(launchKeys({ command: "npx", args: ["-y", "./local-dir"] })).toEqual([]);
    expect(launchKeys({ command: "python", args: ["-m", "my_server"] })).toEqual([]);
  });
});

describe("the trust tier", () => {
  const server = (over: Partial<RegistryServer>): RegistryServer => ({
    id: "x", slug: "x", name: "x", description: null, author: null, repositoryUrl: "https://github.com/a/b",
    npmPackage: null, homepage: null, installCommand: "npx x", stars: null, weeklyDownloads: null,
    qualityScore: 85, isOfficial: true, isVerified: false, supportsDiscovery: false, discoveryUrl: null,
    category: null, tools: [], resources: [], metadata: null, ...over,
  });

  it("is capped by safety as MCP Rating caps it — the gateway used to ignore safety", () => {
    expect(RegistryClient.determineTrustTier(server({ safetyScore: 90 }))).toBe("verified");
    expect(RegistryClient.determineTrustTier(server({ safetyScore: 45 }))).toBe("community");
    expect(RegistryClient.determineTrustTier(server({ safetyScore: 20 }))).toBe("unknown");
    expect(RegistryClient.determineTrustTier(server({ safetyScore: 45, qualityScore: 35, isOfficial: false }))).toBe("community");
  });

  it("counts a hosted server's endpoint as an install command, as MCP Rating does from 2026-10-16", () => {
    const hosted = { isOfficial: false, qualityScore: 70, safetyScore: 90, installCommand: null };
    const remotes = (url: string) => ({ remotes: [{ type: "streamable-http", url }] });
    expect(RegistryClient.determineTrustTier(server({ ...hosted, metadata: remotes("https://mcp.example.com/mcp") }))).toBe("trusted");
    expect(RegistryClient.determineTrustTier(server({ ...hosted, metadata: null }))).toBe("community");
    expect(RegistryClient.determineTrustTier(server({ ...hosted, metadata: remotes("javascript:alert(1)") }))).toBe("community");
    expect(RegistryClient.determineTrustTier(server({ ...hosted, repositoryUrl: null, metadata: remotes("https://mcp.example.com/mcp") }))).toBe("community");
  });
});

describe("what MCP Rating knows, in words", () => {
  const now = new Date("2026-10-14T12:00:00Z");
  const rated: TrustFacts = {
    by: "mcprating.io", consulted: true, url: "https://mcprating.io/servers/chrome-devtools-mcp",
    qualityScore: 71, tier: "trusted", safetyScore: 45, safetyFlags: ["stale", "no-license"],
    verification: { latestOutcome: "verified", lastAttemptedAt: "2026-10-14T03:07:00Z", lastVerifiedAt: "2026-10-14T03:07:00Z", attemptCount: 4, verifiedCount: 3 },
    maintenance: maintenanceFacts({
      version: "1.10.1",
      metadata: { latestRelease: { registry: "npm", version: "1.10.1", publishedAt: "2026-10-01T00:00:00Z", checkedAt: "2026-10-12T00:00:00Z" }, pushedAt: "2026-04-01T00:00:00Z" },
    }),
    delistedReason: null, trustWarning: null,
  };

  it("lists score, safety with each flag's reason, the start test and upkeep", () => {
    expect(trustLines(rated, now)).toEqual([
      "Score: 71/100 · Trust: trusted · https://mcprating.io/servers/chrome-devtools-mcp",
      "Safety: 45/100 (risk).",
      "- stale: No activity for over 6 months.",
      "- no-license: No license declared.",
      "✓ Started in MCP Rating's test (2026-10-14); 3 of 4 attempts started.",
      "Last release: 1.10.1 on 2026-10-01, 13 days ago (npm).",
      "Last code push: 2026-04-01, 6 months ago (GitHub, as of an earlier crawl).",
    ]);
  });

  it("tells 'MCP Rating doesn't know it' apart from 'MCP Rating wasn't asked'", () => {
    const none = { ...rated, by: null, url: null, qualityScore: null, safetyScore: null, safetyFlags: [], verification: null, maintenance: null };
    expect(trustLines({ ...none, consulted: true })).toEqual([
      "MCP Rating has no record of this package: no score, no safety screen, no start test.",
    ]);
    expect(trustLines({ ...none, consulted: false })[0]).toMatch(/^Not rated: MCP Rating isn't one of the configured registries/);
  });

  it("leads with a delisting or a name that points elsewhere", () => {
    expect(trustLines({ ...rated, delistedReason: "Not listed: bulk." })[0]).toBe("⛔ mcprating.io: Not listed: bulk.");
    expect(trustLines({ ...rated, trustWarning: "Name points elsewhere." })[0]).toBe("⚠️ Name points elsewhere.");
  });

  it("says a credentials stop is not a failure, and never-tested is no evidence", () => {
    expect(startTestLine({ latestOutcome: "needs_credentials", lastAttemptedAt: "2026-10-14T03:00:00Z", lastVerifiedAt: null, attemptCount: 1, verifiedCount: 0 })).toMatch(/not a failure/);
    expect(startTestLine(null)).toBe("Not tested by MCP Rating yet — no evidence either way.");
  });
});

describe("factsForLaunch", () => {
  function stubLookup(answer: Record<string, unknown> | null) {
    const fetchMock = vi.fn(async (url: string) => {
      const keys = new URL(url).searchParams.getAll("key");
      return new Response(JSON.stringify({ data: keys.map((key) => ({ key, server: answer })) }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  }
  const record = {
    slug: "chrome-devtools-mcp", name: "chrome-devtools-mcp", url: "https://mcprating.io/servers/chrome-devtools-mcp",
    qualityScore: 71, safetyScore: 90, safetyFlags: [], isOfficial: true, isVerified: false, stars: 1, weeklyDownloads: 1,
    delistedReason: null, verification: null, keys: ["npm:chrome-devtools-mcp"], trustTier: "trusted",
    maintenance: { lastRelease: null, lastCodePush: null, openIssuesAndPrs: null, archived: false, deprecated: false },
  };
  const client = () => new RegistryClient([new McpRatingSource("https://mcprating.io/api/v1")]);

  it("judges a known package started by command as itself", async () => {
    const fetchMock = stubLookup(record);
    const f = await client().factsForLaunch({ command: "npx", args: ["-y", "chrome-devtools-mcp@latest"] });
    expect(f).toMatchObject({ by: "mcprating.io", qualityScore: 71, tier: "trusted", safetyScore: 90 });
    expect(new URL((fetchMock.mock.calls[0] as unknown as [string])[0]).searchParams.getAll("key")).toEqual(["npm:chrome-devtools-mcp"]);
  });

  it("keeps a delisted package unscored and unknown", async () => {
    stubLookup({ ...record, delistedReason: "Not listed: bulk." });
    const f = await client().factsForLaunch({ command: "npx", args: ["chrome-devtools-mcp"] });
    expect(f).toMatchObject({ qualityScore: null, tier: "unknown", delistedReason: "Not listed: bulk." });
  });

  it("asks nothing for a launch with no package, or without MCP Rating", async () => {
    const fetchMock = stubLookup(record);
    expect((await client().factsForLaunch({ command: "node", args: ["server.js"] })).by).toBeNull();
    const noRater = new RegistryClient([{
      label: "registry.example", kind: "mcp-registry",
      search: async () => ({ data: [], total: 0, limit: 10, offset: 0 }), getServer: async () => null, getByName: async () => null,
      getStatus: () => ({ lastSuccessfulCall: null, lastError: null, cacheSize: 0 }), clearCache: () => {},
    }]);
    expect(await noRater.factsForLaunch({ command: "npx", args: ["chrome-devtools-mcp"] })).toMatchObject({ by: null, consulted: false });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("parseMinScore", () => {
  it("reads 0–100, is no rule when unset, and fails closed on anything else", () => {
    expect(parseMinScore(undefined)).toBeUndefined();
    expect(parseMinScore("")).toBeUndefined();
    expect(parseMinScore("60")).toBe(60);
    expect(parseMinScore(45)).toBe(45);
    for (const bad of ["7O", "60.5", "-1", "101", "sixty"]) expect(parseMinScore(bad)).toBe(100);
  });
});
