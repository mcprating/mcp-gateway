import { describe, it, expect } from "vitest";
import { RegistryClient } from "./registry-client.js";
import type { RegistrySource } from "./sources/http-source.js";
import type { RegistryServer } from "./types.js";
import { parseRegistryList } from "../config/gateway-config.js";

function row(slug: string, extra: Partial<RegistryServer> = {}): RegistryServer {
  return {
    id: slug, slug, name: slug, description: null, author: null, repositoryUrl: null, npmPackage: null,
    homepage: null, installCommand: null, stars: null, weeklyDownloads: null, qualityScore: 50,
    isOfficial: false, isVerified: false, supportsDiscovery: false, discoveryUrl: null, category: null,
    tools: [], resources: [], metadata: null, ...extra,
  };
}

function source(label: string, rows: RegistryServer[] | Error, byName: Record<string, RegistryServer> = {}): RegistrySource {
  const status = { lastSuccessfulCall: null, lastError: null, cacheSize: 0 };
  return {
    label,
    kind: label.startsWith("mcprating") ? "mcprating" : "mcp-registry",
    search: async () => {
      if (rows instanceof Error) throw rows;
      return { data: rows.map((r) => ({ ...r, source: label })), total: rows.length, limit: 10, offset: 0 };
    },
    getServer: async (slug) => (rows instanceof Error ? null : rows.find((r) => r.slug === slug) ?? null),
    getByName: async (name) => {
      if (rows instanceof Error) throw rows;
      return byName[name] ?? null;
    },
    getStatus: () => status,
    clearCache: () => {},
  };
}

describe("RegistryClient over several registries", () => {
  it("takes results in turns, and lists a server two registries both have once, as the first has it", async () => {
    const ours = source("mcprating.io", [
      // MCP Rating lists the official entry under its npm row and keeps the name in group.registryNames.
      row("chrome-devtools-mcp", {
        npmPackage: "chrome-devtools-mcp",
        metadata: { group: { registryNames: ["io.github.ChromeDevTools/chrome-devtools-mcp"] } },
      }),
      row("ours-2"),
    ]);
    const official = source("registry.modelcontextprotocol.io", [
      row("io-github-chromedevtools-chrome-devtools-mcp", { registryName: "io.github.ChromeDevTools/chrome-devtools-mcp" }),
      row("io-github-acme-only-there", { registryName: "io.github.acme/only-there" }),
      row("same-npm-package", { npmPackage: "chrome-devtools-mcp" }),
    ]);

    const res = await new RegistryClient([ours, official]).search("chrome");

    expect(res.data.map((s) => `${s.source}:${s.slug}`)).toEqual([
      "mcprating.io:chrome-devtools-mcp",
      "mcprating.io:ours-2",
      "registry.modelcontextprotocol.io:io-github-acme-only-there",
    ]);
    expect(res.unreachable).toBeUndefined();
  });

  it("answers from the registries that did, names the one that didn't, and fails only when none answers", async () => {
    const up = source("registry.example", [row("a")]);
    const down = source("mcprating.io", new Error("ECONNREFUSED"));

    const res = await new RegistryClient([down, up]).search("x");
    expect(res.data.map((s) => s.slug)).toEqual(["a"]);
    expect(res.unreachable).toEqual(["mcprating.io"]);

    await expect(new RegistryClient([down]).search("x")).rejects.toThrow(/No registry answered \(mcprating\.io: ECONNREFUSED\)/);
  });

  it("doesn't wait past its deadline for a slow registry, and says which one it gave up on", async () => {
    const fast = source("mcprating.io", [row("fast")]);
    let finishSlow!: () => void;
    const slow = {
      ...source("registry.slow.example", []),
      search: () =>
        new Promise<never>((_, reject) => {
          finishSlow = () => reject(new Error("late failure"));
        }),
    };
    const client = new RegistryClient([fast, slow]);
    client.searchDeadlineMs = 20;

    const res = await client.search("x");
    expect(res.data.map((s) => s.slug)).toEqual(["fast"]);
    expect(res.unreachable).toEqual(["registry.slow.example"]);
    finishSlow(); // a late outcome is handled, not an unhandled rejection
  });

  it("looks a registry name up in each registry in order, and a slug by slug", async () => {
    const acme = row("io-github-acme-tool", { registryName: "io.github.acme/tool" });
    const ours = source("mcprating.io", [row("ours")]);
    const company = source("registry.acme.internal", [acme], { "io.github.acme/tool": acme });
    const client = new RegistryClient([ours, company]);

    expect((await client.getServer("io.github.acme/tool"))?.slug).toBe("io-github-acme-tool");
    expect((await client.getServer("ours"))?.slug).toBe("ours");
    expect(await client.getServer("io.github.nobody/none")).toBeNull();
  });

  it("reports each registry's reachability", () => {
    const client = new RegistryClient([source("mcprating.io", []), source("registry.example", [])]);
    expect(client.getStatus().registries.map((r) => `${r.kind}:${r.label}`)).toEqual([
      "mcprating:mcprating.io",
      "mcp-registry:registry.example",
    ]);
  });
});

describe("parseRegistryList", () => {
  it("tells the two APIs apart by path, or by an explicit type", () => {
    expect(
      parseRegistryList([
        "https://mcprating.io/api/v1/",
        "https://registry.modelcontextprotocol.io",
        "mcprating=http://localhost:3000/api/v1",
        "mcp-registry=https://mcprating.io",
        { type: "mcp-registry", url: "https://registry.acme.internal/" },
      ]),
    ).toEqual([
      { type: "mcprating", url: "https://mcprating.io/api/v1" },
      { type: "mcp-registry", url: "https://registry.modelcontextprotocol.io" },
      { type: "mcprating", url: "http://localhost:3000/api/v1" },
      { type: "mcp-registry", url: "https://mcprating.io" },
      { type: "mcp-registry", url: "https://registry.acme.internal" },
    ]);
  });

  it("drops what isn't an http(s) URL, and leaves the default when nothing is left", () => {
    expect(parseRegistryList(["file:///etc/passwd", "not a url"])).toBeUndefined();
    expect(parseRegistryList(undefined)).toBeUndefined();
    expect(parseRegistryList([])).toBeUndefined();
  });

  it("defaults to MCP Rating alone", () => {
    const client = RegistryClient.fromConfig({ registryApiUrl: "https://mcprating.io/api/v1", registryCacheTtlMs: 1000 });
    expect(client.registries).toEqual([{ label: "mcprating.io", kind: "mcprating" }]);
  });
});
