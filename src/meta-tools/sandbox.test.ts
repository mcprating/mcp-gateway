import { describe, it, expect, vi } from "vitest";
import { registerSandbox } from "./sandbox.js";
import type { CapabilityManifest } from "../sandbox/types.js";
import type { TrustTier } from "../registry/types.js";

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
  /** What the live connection's connect resolved, when it fell back from it. */
  resolved?: CapabilityManifest;
  trustTier?: TrustTier;
  /** The registry record the live connection's connect used. */
  registryServer?: unknown;
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
      getConnection: () =>
        opts.live
          ? {
              manifest: opts.live,
              resolvedManifest: opts.resolved,
              trustTier: opts.trustTier ?? "unknown",
              registryServer: opts.registryServer ?? null,
            }
          : undefined,
    } as never,
    { getServer } as never,
  );
  const set = async (input: Record<string, unknown> = REGISTRY_ONLY) => {
    const res = await handler(input);
    expect(res.isError).toBeFalsy();
    return { text: res.content[0].text, saved: saveOverride.mock.calls[0]?.[0] };
  };
  const view = async () => (await handler({ action: "view", slug: "srv" })).content[0].text;
  return { set, view, getServer };
}

const CONTAINED: CapabilityManifest = {
  version: 1,
  slug: "srv",
  enforcement: "l2-container",
  env: { allow: ["API_KEY"], inheritDefaults: true },
  network: { mode: "none", allow: [] },
  filesystem: { read: [], write: [] },
  subprocess: false,
};

const ON_HOST: CapabilityManifest = { ...CONTAINED, enforcement: "l1-process" };

const GITHUB_RECORD = {
  slug: "srv",
  qualityScore: 45,
  authDetails: { envVars: [{ name: "GITHUB_TOKEN" }], allEnvVars: [], schemes: [] },
};

/** What connect records for CONTAINED with no Docker or Podman to run it. */
const FELL_BACK = { live: { ...CONTAINED, enforcement: "l1-process" as const }, resolved: CONTAINED };

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
    const { set } = setup({ getServer: async () => GITHUB_RECORD });
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

  it("changes a saved override without asking the registry", async () => {
    const { set, getServer } = setup({ saved: CONTAINED, live: ON_HOST });
    const { text, saved } = await set();
    expect(getServer).not.toHaveBeenCalled();
    expect(saved?.env.allow).toEqual(["API_KEY"]);
    expect(text).toContain("Changed the saved override");
  });

  it("doesn't save the env names passed to a live connection's connect", async () => {
    // What resolve() gives a connect passed env: {PASSED_AT_CONNECT}.
    const live = { ...CONTAINED, env: { allow: ["GITHUB_TOKEN", "PASSED_AT_CONNECT"], inheritDefaults: true } };
    const { set, getServer } = setup({ live, trustTier: "community", registryServer: GITHUB_RECORD });
    const { text, saved } = await set();
    expect(getServer).not.toHaveBeenCalled();
    expect(saved?.env.allow).toEqual(["GITHUB_TOKEN"]);
    expect(saved?.enforcement).toBe("l2-container");
    expect(text).toContain("the defaults for this connection's trust tier, `community`");
    expect(text).toContain("Env names passed to mcp_connect aren't saved");
  });

  it("starts from the defaults, not an override reset since the connection used it", async () => {
    const stale: CapabilityManifest = {
      ...ON_HOST,
      network: { mode: "all", allow: [] },
      filesystem: { read: [], write: ["/home/u"] },
    };
    const { saved } = await setup({ live: stale }).set();
    expect(saved).toMatchObject({ enforcement: "l2-container", filesystem: { read: [], write: [] } });
  });

  it("keeps the container for a connection that fell back to L1 with no engine, and says why", async () => {
    const { set } = setup(FELL_BACK);
    const { text, saved } = await set();
    expect(saved).toMatchObject({
      enforcement: "l2-container",
      network: { mode: "allowlist", allow: ["registry.npmjs.org"] },
    });
    expect(text).toContain(
      "The live connection runs as `l1-process`: no container engine (Docker or Podman) was found",
    );
  });
});

describe("mcp_sandbox view", () => {
  it("shows what a fallen-back connection runs as, and what its manifest asks for", async () => {
    const { view } = setup(FELL_BACK);
    const text = await view();
    expect(text).toContain("**Enforcement:** l1-process");
    expect(text).toContain("Runs as `l1-process`: its manifest asks for `l2-container`");
  });

  it("adds nothing for a connection running what it resolved", async () => {
    const { view } = setup({ live: CONTAINED });
    expect(await view()).not.toContain("Runs as");
  });
});
