import { describe, it, expect, vi, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { RegistryClient } from "./registry-client.js";

const pkg = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf-8"));

afterEach(() => vi.unstubAllGlobals());

// The registry counts the gateway's searches by this header, separately from
// its own tests; without it the two were indistinguishable.
describe("registry requests", () => {
  it("identify the gateway and its version, and nothing else", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ data: [], total: 0, limit: 10, offset: 0 }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await new RegistryClient("https://registry.invalid/api/v1").search("web search");

    const init = (fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1];
    const headers = init.headers as Record<string, string>;
    expect(headers["User-Agent"]).toBe(`mcp-rating-gateway/${pkg.version} (+https://github.com/mcprating/mcp-gateway)`);
    expect(Object.keys(headers)).toEqual(["User-Agent"]);
  });
});
