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
  /** MCP_GATEWAY_CONTAINER_ISOLATION; on unless a test says otherwise. */
  containerIsolation?: boolean;
  /** The slug the saved override and the live connection are filed under. */
  at?: string;
  getServer?: (ref: string) => Promise<unknown>;
}) {
  let handler!: Handler;
  const server = {
    tool: (_n: string, _d: string, _s: unknown, h: Handler) => {
      handler = h;
    },
  };
  const at = opts.at ?? "srv";
  const saveOverride = vi.fn<(m: CapabilityManifest) => void>();
  const clearOverride = vi.fn<(slug: string) => void>();
  const getServer = vi.fn(opts.getServer ?? (async () => null));
  registerSandbox(
    server as never,
    {
      manifestResolver: {
        getOverride: (slug: string) => (slug === at ? opts.saved : undefined),
        saveOverride,
        clearOverride,
        containerIsolation: opts.containerIsolation ?? true,
      },
      getConnection: (slug: string) =>
        opts.live && slug === at
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
  const view = async (slug = "srv") => (await handler({ action: "view", slug })).content[0].text;
  return { set, view, call: handler, getServer, saveOverride, clearOverride };
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
const FELL_BACK = { live: ON_HOST, resolved: CONTAINED };

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

  it("tells a fallen-back connection to start an engine, not to turn on isolation that is on", async () => {
    const { view } = setup(FELL_BACK);
    const text = await view();
    expect(text).toContain("no Docker or Podman was found; start one and reconnect to restrict");
    expect(text).not.toContain("MCP_GATEWAY_CONTAINER_ISOLATION");
  });

  it("points a verified server under isolation at an override, the one thing that contains it", async () => {
    const { view } = setup({ live: ON_HOST, trustTier: "verified" });
    const text = await view();
    expect(text).toContain('mcp_sandbox({action: "set", slug: "srv", enforcement: "l2-container"})');
    expect(text).not.toContain("MCP_GATEWAY_CONTAINER_ISOLATION");
  });

  it("suggests the isolation setting where it is off and would contain the server", async () => {
    const { view } = setup({ live: ON_HOST, trustTier: "community", containerIsolation: false });
    expect(await view()).toContain("(set MCP_GATEWAY_CONTAINER_ISOLATION=true to restrict)");
  });
});

/**
 * A connect by registry name knows the server by the registry's slug for it.
 * mcp_sandbox used to file overrides under whatever it was passed, so one set
 * by name sat under the name, and the connect never found it.
 */
describe("mcp_sandbox with a registry name", () => {
  const NAME = "io.github.acme/srv";
  const SLUG = "io-github-acme-srv";
  const byName = async (ref: string) => (ref === NAME ? { ...GITHUB_RECORD, slug: SLUG, name: NAME } : null);

  it("files the override under the slug a connect by that name uses, with that server's tier", async () => {
    const { set, getServer } = setup({ getServer: byName });
    const { text, saved } = await set({ ...REGISTRY_ONLY, slug: NAME });
    expect(saved).toMatchObject({ slug: SLUG, enforcement: "l2-container", env: { allow: ["GITHUB_TOKEN"] } });
    // Looked up once, by name: another registry's server can't be found by its slug.
    expect(getServer.mock.calls).toEqual([[NAME]]);
    expect(text).toContain(`\`${NAME}\` is known here by its slug, \`${SLUG}\``);
    expect(text).toContain("`community` trust tier");
  });

  it("finds a connection made by that name, under its slug", async () => {
    const { view } = setup({ getServer: byName, live: ON_HOST, at: SLUG });
    const text = await view(NAME);
    expect(text).toContain(`## 🛡️ Sandbox: \`${SLUG}\` (active connection)`);
    expect(text).toContain("**Enforcement:** l1-process");
  });

  it("resets the override filed under the slug", async () => {
    const { call, clearOverride } = setup({ getServer: byName });
    await call({ action: "reset", slug: NAME });
    expect(clearOverride).toHaveBeenCalledWith(SLUG);
  });

  it("refuses a name no registry has, and saves nothing", async () => {
    const { call, saveOverride } = setup({ getServer: byName });
    const res = await call({ ...REGISTRY_ONLY, slug: "io.github.nobody/none" });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain('No registry has a server named "io.github.nobody/none"');
    expect(saveOverride).not.toHaveBeenCalled();
  });

  it("refuses a name when no registry answers, rather than guess its slug", async () => {
    const { call, saveOverride } = setup({
      getServer: async () => {
        throw new Error("No registry answered");
      },
    });
    const res = await call({ ...REGISTRY_ONLY, slug: NAME });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain("No registry answered: try again, or pass the slug");
    expect(saveOverride).not.toHaveBeenCalled();
  });
});
