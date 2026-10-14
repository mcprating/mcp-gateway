import { describe, it, expect, vi } from "vitest";
import { registerSandbox } from "./sandbox.js";
import type { CapabilityManifest } from "../sandbox/types.js";

/**
 * The handler around overrideForSet: it asks the registry for the trust tier
 * only when a server has neither a saved override nor a live connection, takes
 * a failed lookup as "unknown", and tells the user what the override was built
 * on, since the fields they didn't pass came from it.
 */

type Handler = (
  input: Record<string, unknown>,
) => Promise<{ isError?: boolean; content: Array<{ text: string }> }>;

const REGISTRY_ONLY = {
  action: "set",
  slug: "srv",
  network: "allowlist",
  networkAllow: ["registry.npmjs.org"],
};

function setup(opts: {
  saved?: CapabilityManifest;
  live?: CapabilityManifest;
  getServer?: () => Promise<unknown>;
}) {
  let handler!: Handler;
  const server = {
    tool: (_n: string, _d: string, _s: unknown, h: Handler) => {
      handler = h;
    },
  };
  const saveOverride = vi.fn<(m: CapabilityManifest) => void>();
  const getServer = vi.fn(opts.getServer ?? (async () => null));
  registerSandbox(
    server as never,
    {
      manifestResolver: {
        getOverride: () => opts.saved,
        saveOverride,
        containerIsolation: true,
      },
      getConnection: () => (opts.live ? { manifest: opts.live } : undefined),
    } as never,
    { getServer } as never,
  );
  const set = async (input: Record<string, unknown> = REGISTRY_ONLY) => {
    const res = await handler(input);
    expect(res.isError).toBeFalsy();
    return { text: res.content[0].text, saved: saveOverride.mock.calls[0]?.[0] };
  };
  return { set, getServer };
}

describe("mcp_sandbox set", () => {
  it("keeps a slug the registry doesn't know in its container, as unknown", async () => {
    const { set } = setup({});
    const { text, saved } = await set();
    expect(saved).toMatchObject({
      slug: "srv",
      enforcement: "l2-container",
      network: { mode: "allowlist", allow: ["registry.npmjs.org"] },
    });
    expect(text).toContain("isn't a registry slug");
    expect(text).toContain("`unknown` trust tier");
  });

  it("takes the tier and the declared env vars from the registry record", async () => {
    const { set } = setup({
      getServer: async () => ({
        slug: "srv",
        qualityScore: 45,
        authDetails: { envVars: [{ name: "GITHUB_TOKEN" }], allEnvVars: [], schemes: [] },
      }),
    });
    const { text, saved } = await set();
    expect(saved?.enforcement).toBe("l2-container");
    expect(saved?.env.allow).toEqual(["GITHUB_TOKEN"]);
    expect(text).toContain("`community` trust tier");
  });

  it("falls back to unknown when the registry can't be reached, and says what that leaves out", async () => {
    const { set } = setup({
      getServer: async () => {
        throw new Error("Failed to reach MCP-Rating registry");
      },
    });
    const { text, saved } = await set();
    expect(saved).toMatchObject({ enforcement: "l2-container", env: { allow: [] } });
    expect(text).toContain("couldn't be reached");
    expect(text).toContain("envAllow");
  });

  it("doesn't ask the registry when there is a saved override or a live connection", async () => {
    const m: CapabilityManifest = {
      version: 1,
      slug: "srv",
      enforcement: "l2-container",
      env: { allow: ["API_KEY"], inheritDefaults: true },
      network: { mode: "none", allow: [] },
      filesystem: { read: [], write: [] },
      subprocess: false,
    };
    for (const [opts, said] of [
      [{ saved: m }, "Changed the saved override"],
      [{ live: m }, "Started from the live connection's manifest"],
    ] as const) {
      const { set, getServer } = setup(opts);
      const { text, saved } = await set();
      expect(getServer).not.toHaveBeenCalled();
      expect(saved?.env.allow).toEqual(["API_KEY"]);
      expect(text).toContain(said);
    }
  });
});
