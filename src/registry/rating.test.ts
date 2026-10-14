import { describe, it, expect, vi, afterEach } from "vitest";
import { RegistryClient } from "./registry-client.js";
import { McpRatingSource } from "./sources/mcprating-source.js";
import { fromServerJson, type ServerEntry } from "./sources/mcp-registry-source.js";
import type { RegistrySource } from "./sources/http-source.js";
import { lookupKeys, ociKey, remoteKey } from "./package-keys.js";

/**
 * A server found in another registry gets MCP Rating's record of the same
 * PACKAGE — never of the same name, which any registry can give anything.
 */

afterEach(() => vi.unstubAllGlobals());

const entry = (name: string, pkg: { registryType: string; identifier: string }): ServerEntry => ({
  server: { name, description: `${name} server`, packages: [pkg] },
});

const genuine = entry("io.github.ChromeDevTools/chrome-devtools-mcp", { registryType: "npm", identifier: "chrome-devtools-mcp" });
// A company registry reusing the well-known name for its own package.
const impostor = entry("io.github.ChromeDevTools/chrome-devtools-mcp", { registryType: "npm", identifier: "chrome-devtools-mcp-plus" });
const banned = entry("io.github.sadri-dridi/f-to-c", { registryType: "npm", identifier: "f-to-c" });
const unknown = entry("com.acme/internal", { registryType: "pypi", identifier: "Acme_Internal" });

function otherRegistry(entries: ServerEntry[]): RegistrySource {
  return {
    label: "registry.acme.internal",
    kind: "mcp-registry",
    search: async () => ({ data: entries.map((e) => fromServerJson(e, "registry.acme.internal")), total: entries.length, limit: 10, offset: 0 }),
    getServer: async () => null,
    getByName: async (name) => {
      const e = entries.find((x) => x.server.name === name);
      return e ? fromServerJson(e, "registry.acme.internal") : null;
    },
    getStatus: () => ({ lastSuccessfulCall: null, lastError: null, cacheSize: 0 }),
    clearCache: () => {},
  };
}

const record = (slug: string, keys: string[], extra: Record<string, unknown> = {}) => ({
  slug, name: slug, url: `https://mcprating.io/servers/${slug}`, qualityScore: 71, safetyScore: 90, safetyFlags: [],
  isOfficial: true, isVerified: false, stars: 100, weeklyDownloads: 5000, delistedReason: null,
  verification: { latestOutcome: "verified", lastAttemptedAt: "2026-10-14T03:00:00Z", lastVerifiedAt: "2026-10-14T03:00:00Z", attemptCount: 3, verifiedCount: 3 },
  keys, ...extra,
});

/** MCP Rating: an empty search, and /servers/lookup answering from `known`. */
function stubMcpRating(known: Record<string, ReturnType<typeof record> | null>) {
  const fetchMock = vi.fn(async (url: string) => {
    const u = new URL(url);
    if (u.pathname.endsWith("/servers/lookup")) {
      const keys = u.searchParams.getAll("key");
      return new Response(JSON.stringify({ data: keys.map((key) => ({ key, server: known[key] ?? null })) }), { status: 200 });
    }
    return new Response(JSON.stringify({ data: [], total: 0, limit: 10, offset: 0 }), { status: 200 });
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

const chromeRecord = record("chrome-devtools-mcp", ["npm:chrome-devtools-mcp", "name:io.github.chromedevtools/chrome-devtools-mcp"]);

describe("rating servers from other registries", () => {
  it("gives a server MCP Rating's record of the same package, in one request for the page", async () => {
    const fetchMock = stubMcpRating({ "npm:chrome-devtools-mcp": chromeRecord });
    const client = new RegistryClient([new McpRatingSource("https://mcprating.io/api/v1"), otherRegistry([genuine, unknown])]);

    const res = await client.search("chrome");
    const chrome = res.data.find((s) => s.npmPackage === "chrome-devtools-mcp")!;
    expect(chrome).toMatchObject({
      qualityScore: 71,
      safetyScore: 90,
      rating: { by: "mcprating.io", slug: "chrome-devtools-mcp", url: "https://mcprating.io/servers/chrome-devtools-mcp" },
    });
    expect(chrome.verification?.latestOutcome).toBe("verified");
    expect(chrome.trustWarning).toBeUndefined();
    // The package MCP Rating doesn't know stays unrated.
    expect(res.data.find((s) => s.registryName === "com.acme/internal")?.qualityScore).toBeNull();

    const lookups = fetchMock.mock.calls.map((c) => new URL((c as unknown as [string])[0])).filter((u) => u.pathname.endsWith("/lookup"));
    expect(lookups).toHaveLength(1);
    expect(lookups[0].searchParams.getAll("key").sort()).toEqual([
      "name:com.acme/internal",
      "name:io.github.chromedevtools/chrome-devtools-mcp",
      "npm:chrome-devtools-mcp",
      "pypi:acme-internal",
    ]);
  });

  it("doesn't hand a well-known name's score to another package, and says the name points elsewhere", async () => {
    stubMcpRating({ "name:io.github.chromedevtools/chrome-devtools-mcp": chromeRecord });
    const client = new RegistryClient([new McpRatingSource("https://mcprating.io/api/v1"), otherRegistry([impostor])]);

    const [s] = (await client.search("chrome")).data;
    expect(s.qualityScore).toBeNull();
    expect(s.rating).toBeUndefined();
    expect(RegistryClient.determineTrustTier(s)).toBe("unknown");
    expect(s.trustWarning).toBe(
      "MCP Rating knows io.github.ChromeDevTools/chrome-devtools-mcp as npm:chrome-devtools-mcp; this registry's entry of that name runs npm:chrome-devtools-mcp-plus.",
    );
  });

  it("leaves a package MCP Rating delisted unrated, with the reason", async () => {
    const reason = "Not listed: published in bulk.";
    stubMcpRating({ "npm:f-to-c": record("io-github-sadri-dridi-f-to-c", ["npm:f-to-c"], { delistedReason: reason }) });
    const client = new RegistryClient([new McpRatingSource("https://mcprating.io/api/v1"), otherRegistry([banned])]);

    const [s] = (await client.search("celsius")).data;
    expect(s.delistedReason).toBe(reason);
    expect(s.qualityScore).toBeNull();
  });

  it("shows the rows unrated when MCP Rating can't answer, rather than failing the search", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string) =>
      url.includes("/servers/lookup")
        ? new Response("{}", { status: 400, statusText: "Bad Request" })
        : new Response(JSON.stringify({ data: [], total: 0, limit: 10, offset: 0 }), { status: 200 }),
    ));
    const client = new RegistryClient([new McpRatingSource("https://mcprating.io/api/v1"), otherRegistry([genuine])]);
    const [s] = (await client.search("chrome")).data;
    expect(s.qualityScore).toBeNull();
  });

  it("rates a server looked up by name too", async () => {
    stubMcpRating({ "npm:chrome-devtools-mcp": chromeRecord });
    const client = new RegistryClient([new McpRatingSource("https://mcprating.io/api/v1"), otherRegistry([genuine])]);
    // MCP Rating's own feed doesn't know the name here (404), so the company registry answers.
    const s = await client.getServer("io.github.ChromeDevTools/chrome-devtools-mcp");
    expect(s?.source).toBe("registry.acme.internal");
    expect(s?.qualityScore).toBe(71);
  });

  it("sends nothing to MCP Rating when it isn't a configured registry", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const client = new RegistryClient([otherRegistry([genuine])]);
    const [s] = (await client.search("chrome")).data;
    expect(s.qualityScore).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("lookup keys", () => {
  it("are built the way MCP Rating builds them", () => {
    // The same cases as MCP Rating's tests/unit/db/package-keys.test.ts.
    expect(ociKey("index.docker.io/mcp/github:latest")).toBe("oci:mcp/github");
    expect(ociKey("postgres")).toBe("oci:library/postgres");
    expect(ociKey("ghcr.io/acme/mcp:1.0")).toBe("oci:ghcr.io/acme/mcp");
    expect(remoteKey("https://MCP.Example.com/mcp/")).toBe("remote:https://mcp.example.com/mcp");
    expect(remoteKey("file:///etc/passwd")).toBeNull();
  });

  it("cover every package a server declares, launchable or not, its endpoints and its name", () => {
    const s = fromServerJson(
      {
        server: {
          name: "io.github.Acme/multi",
          packages: [
            // Needs the user's input, so no launch command — but still the package it would run.
            { registryType: "pypi", identifier: "Acme_Multi", packageArguments: [{ type: "named", name: "--key", isRequired: true }] },
            { registryType: "oci", identifier: "docker.io/acme/multi:2" },
          ],
          remotes: [{ type: "streamable-http", url: "https://multi.acme.example/mcp" }],
        },
      },
      "registry.example",
    );
    expect(lookupKeys(s)).toEqual({
      packages: ["pypi:acme-multi", "oci:acme/multi", "remote:https://multi.acme.example/mcp"],
      name: "name:io.github.acme/multi",
    });
  });
});
