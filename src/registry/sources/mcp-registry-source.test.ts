import { describe, it, expect, vi, afterEach } from "vitest";
import { fromServerJson, McpRegistrySource, slugForName, type ServerEntry } from "./mcp-registry-source.js";
import { RegistryClient } from "../registry-client.js";

afterEach(() => vi.unstubAllGlobals());

const npmEntry: ServerEntry = {
  server: {
    name: "io.github.Acme/notes-mcp",
    title: "Acme Notes",
    description: "Search and edit notes",
    version: "1.4.0",
    repository: { url: "https://github.com/Acme/notes-mcp" },
    packages: [
      {
        registryType: "npm",
        identifier: "@acme/notes-mcp",
        version: "1.4.0",
        packageArguments: [{ type: "positional", value: "--stdio" }],
        environmentVariables: [
          { name: "ACME_TOKEN", description: "API token", isRequired: true, isSecret: true },
          { name: "ACME_REGION" },
        ],
      },
    ],
  },
  _meta: {
    // Another registry's numbers under MCP Rating's key: must not be read.
    "io.mcprating/custom": { quality_score: 99, slug: "spoofed" },
  },
};

const remoteEntry: ServerEntry = {
  server: {
    name: "com.example/hosted",
    description: "Hosted search",
    remotes: [{ type: "streamable-http", url: "https://mcp.example.com/mcp", headers: [{ name: "X-Key", isRequired: true }] }],
  },
};

describe("fromServerJson", () => {
  it("takes identity, launch and declared keys from the entry, and gives no score", () => {
    const s = fromServerJson(npmEntry, "registry.example");
    expect(s).toMatchObject({
      slug: "io-github-acme-notes-mcp",
      name: "Acme Notes",
      ref: "io.github.Acme/notes-mcp",
      registryName: "io.github.Acme/notes-mcp",
      source: "registry.example",
      installCommand: "npx @acme/notes-mcp --stdio",
      npmPackage: "@acme/notes-mcp",
      accessMethod: "npm",
      repositoryUrl: "https://github.com/Acme/notes-mcp",
      qualityScore: null,
      verification: null,
      requiresAuth: true,
    });
    expect(s.authDetails?.envVars).toEqual([{ name: "ACME_TOKEN", description: "API token" }]);
    expect(RegistryClient.determineTrustTier(s)).toBe("unknown");
  });

  it("maps a hosted-only entry to its endpoint, with the header it needs", () => {
    const s = fromServerJson(remoteEntry, "registry.example");
    expect(s.installCommand).toBeNull();
    expect(s.accessMethod).toBe("remote");
    const client = new RegistryClient("https://registry.invalid/api/v1");
    expect(client.resolveRemote(s)).toEqual({
      url: "https://mcp.example.com/mcp",
      transportType: "streamable-http",
      requiredHeaders: ["X-Key"],
    });
  });

  it("gives registry names the slug MCP Rating gives them, usable in a tool name", () => {
    expect(slugForName("io.github.ChromeDevTools/chrome-devtools-mcp")).toBe("io-github-chromedevtools-chrome-devtools-mcp");
    expect(slugForName("com.example/hosted")).toMatch(/^[a-z0-9_-]+$/);
  });
});

function stubFetch(routes: Record<string, unknown>) {
  const fetchMock = vi.fn(async (url: string) => {
    const path = new URL(url).pathname + new URL(url).search;
    const hit = Object.entries(routes).find(([prefix]) => path.startsWith(prefix));
    return hit
      ? new Response(JSON.stringify(hit[1]), { status: 200 })
      : new Response("{}", { status: 404, statusText: "Not Found" });
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("McpRegistrySource", () => {
  const other: ServerEntry = { server: { name: "io.github.x/notes-sync", description: "Sync" } };
  const deleted: ServerEntry = {
    server: { name: "io.github.y/notes-search", description: "Search notes" },
    _meta: { "io.modelcontextprotocol.registry/official": { status: "deleted" } },
  };

  it("asks for the longest word, latest versions only, and ranks by how many words match", async () => {
    const fetchMock = stubFetch({ "/v0.1/servers?": { servers: [other, npmEntry, deleted] } });
    const source = new McpRegistrySource("https://registry.example/v0.1/");

    const res = await source.search("search notes", { limit: 5 });

    const url = new URL((fetchMock.mock.calls[0] as unknown as [string])[0]);
    expect(url.origin + url.pathname).toBe("https://registry.example/v0.1/servers");
    expect(url.searchParams.get("search")).toBe("search");
    expect(url.searchParams.get("version")).toBe("latest");
    // Both words for Acme, one for the sync server; the deleted entry is gone.
    expect(res.data.map((s) => s.registryName)).toEqual(["io.github.Acme/notes-mcp", "io.github.x/notes-sync"]);
  });

  it("sends the gateway's User-Agent and nothing else — no partner key to another registry", async () => {
    const fetchMock = stubFetch({ "/v0.1/servers?": { servers: [] } });
    await new McpRegistrySource("https://registry.example").search("notes");
    const headers = (fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].headers as Record<string, string>;
    expect(Object.keys(headers)).toEqual(["User-Agent"]);
  });

  it("finds a server by registry name, and by the slug of one it has returned", async () => {
    stubFetch({
      "/v0.1/servers/io.github.Acme%2Fnotes-mcp/versions/latest": npmEntry,
      "/v0.1/servers?": { servers: [npmEntry] },
    });
    const source = new McpRegistrySource("https://registry.example");

    expect((await source.getByName("io.github.Acme/notes-mcp"))?.slug).toBe("io-github-acme-notes-mcp");
    expect(await source.getByName("io.github.nobody/none")).toBeNull();
    expect(await source.getServer("never-seen")).toBeNull();
    await source.search("notes");
    expect((await source.getServer("io-github-acme-notes-mcp"))?.registryName).toBe("io.github.Acme/notes-mcp");
  });
});
