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
  /** What the latest connect attempt for that slug worked out (lastTrust). */
  attempt?: { trustTier: TrustTier; registryServer: unknown };
  /** Other overrides in the file, by key: e.g. one saved under a registry name. */
  filed?: Record<string, CapabilityManifest>;
  getServer?: (ref: string) => Promise<unknown>;
}) {
  let handler!: Handler;
  const server = {
    tool: (_n: string, _d: string, _s: unknown, h: Handler) => {
      handler = h;
    },
  };
  const at = opts.at ?? "srv";
  const file: Record<string, CapabilityManifest> = { ...opts.filed };
  if (opts.saved) file[at] = opts.saved;
  const saveOverride = vi.fn<(m: CapabilityManifest) => void>();
  const clearOverride = vi.fn((slug: string) => {
    delete file[slug];
  });
  const getServer = vi.fn(opts.getServer ?? (async () => null));
  registerSandbox(
    server as never,
    {
      manifestResolver: {
        getOverride: (slug: string) => file[slug],
        saveOverride,
        clearOverride,
        nameKeyedOverrides: () => Object.keys(file).filter((k) => k.includes("/")),
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
      lastTrust: (slug: string) => (slug === at ? opts.attempt : undefined),
    } as never,
    {
      getServer,
      registries: [
        { label: "mcprating.io", kind: "mcprating" },
        { label: "registry.acme.internal", kind: "mcp-registry" },
      ],
    } as never,
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
    // Not "as a connect by command gets": since 0.4.0 that takes the package's tier.
    expect(text).not.toContain("which a connect by command or URL also gets");
    expect(text).toContain("try mcp_connect once (even a refused or failed attempt records the tier)");
  });

  /**
   * A slug made from a command (npx-chrome-devtools-mcp) isn't in any
   * registry, and can't be turned back into the package a connect by that
   * command is judged by. The latest connect attempt worked the tier out.
   */
  it("builds on the tier the last connect attempt worked out, with nothing connected", async () => {
    const { set, getServer } = setup({ attempt: { trustTier: "verified", registryServer: null } });
    const { text, saved } = await set();
    expect(getServer).not.toHaveBeenCalled();
    // verified's defaults, not unknown's: no container, subprocesses allowed.
    expect(saved).toMatchObject({ enforcement: "l1-process", subprocess: true, env: { allow: [] } });
    expect(text).toContain("the trust tier its last connect attempt worked out, `verified`");
  });

  it("prefers a live connection to the last attempt", async () => {
    const { saved } = await setup({
      live: ON_HOST,
      trustTier: "community",
      attempt: { trustTier: "verified", registryServer: null },
    }).set();
    expect(saved?.enforcement).toBe("l2-container");
  });

  it("takes the tier and the declared env vars from the registry record", async () => {
    const { set } = setup({ getServer: async () => GITHUB_RECORD });
    const { text, saved } = await set();
    expect(saved?.enforcement).toBe("l2-container");
    expect(saved?.env.allow).toEqual(["GITHUB_TOKEN"]);
    expect(text).toContain("`community` trust tier");
  });

  it("falls back to unknown when no registry answers, and says what that leaves out", async () => {
    const { set } = setup({
      getServer: async () => {
        throw new Error('No registry answered for "srv"');
      },
    });
    const { text, saved } = await set();
    expect(saved).toMatchObject({ enforcement: "l2-container", env: { allow: [] } });
    // Every configured registry was asked, not only MCP Rating's.
    expect(text).toContain("no registry answered when asked about `srv` (mcprating.io, registry.acme.internal)");
    expect(text).not.toContain("MCP-Rating registry");
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

  /**
   * Before names were resolved, set by name saved under the name itself. No
   * connect applied such an override, and since names resolve to slugs,
   * nothing reached it either: it sat in the file for good.
   */
  describe("an override saved under the name itself, from before", () => {
    const OLD: CapabilityManifest = {
      ...CONTAINED,
      slug: NAME,
      network: { mode: "all", allow: [] },
      filesystem: { read: [], write: ["/home/u"] },
    };

    it("is shown by view, with what it said and that it was never applied", async () => {
      const text = await setup({ getServer: byName, filed: { [NAME]: OLD } }).view(NAME);
      expect(text).toContain(`Still in the overrides file: the override saved under the name \`${NAME}\` itself`);
      expect(text).toContain("which no connect ever applied");
      expect(text).toContain('"network":{"mode":"all","allow":[]}');
    });

    it("is removed by reset, along with the slug's", async () => {
      const { call, clearOverride } = setup({ getServer: byName, filed: { [NAME]: OLD } });
      const res = await call({ action: "reset", slug: NAME });
      expect(clearOverride.mock.calls).toEqual([[SLUG], [NAME]]);
      expect(res.content[0].text).toContain(`Also removed the override saved under the name \`${NAME}\` itself`);
    });

    it("is removed by reset even when the name no longer resolves", async () => {
      const GONE = "io.github.gone/srv";
      const { call, clearOverride } = setup({ getServer: byName, filed: { [GONE]: { ...OLD, slug: GONE } } });
      const res = await call({ action: "reset", slug: GONE });
      expect(res.isError).toBeFalsy();
      expect(clearOverride.mock.calls).toEqual([[GONE]]);
      expect(res.content[0].text).toContain("Nothing filed under a slug was touched");
      // view still shows it rather than only the error.
      const { view } = setup({ getServer: byName, filed: { [GONE]: { ...OLD, slug: GONE } } });
      expect(await view(GONE)).toContain("Still in the overrides file");
    });

    it("is replaced by set, which doesn't start from it", async () => {
      const { set, clearOverride } = setup({ getServer: byName, filed: { [NAME]: OLD } });
      const { text, saved } = await set({ ...REGISTRY_ONLY, slug: NAME });
      // The tier's defaults, not the old override's network:all and write path.
      expect(saved).toMatchObject({
        slug: SLUG,
        network: { mode: "allowlist", allow: ["registry.npmjs.org"] },
        filesystem: { read: [], write: [] },
      });
      expect(clearOverride).toHaveBeenCalledWith(NAME);
      expect(text).toContain("This override replaces it, and didn't start from it");
      expect(text).toContain('"write":["/home/u"]');
    });

    it("isn't touched by a set whose name doesn't resolve", async () => {
      const GONE = "io.github.gone/srv";
      const { call, clearOverride, saveOverride } = setup({ getServer: byName, filed: { [GONE]: OLD } });
      const res = await call({ ...REGISTRY_ONLY, slug: GONE });
      expect(res.isError).toBe(true);
      expect(saveOverride).not.toHaveBeenCalled();
      expect(clearOverride).not.toHaveBeenCalled();
    });

    it("is listed by any view, so it can be found without remembering the name", async () => {
      const filed = { "io.github.a/one": OLD, "io.github.b/two": OLD };
      const text = await setup({ filed }).view("srv");
      expect(text).toContain("The overrides file also has 2 overrides saved under a registry name");
      expect(text).toContain("`io.github.a/one`, `io.github.b/two`");
      expect(await setup({}).view("srv")).not.toContain("saved under a registry name");
    });
  });
});
