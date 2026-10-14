import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  ManifestResolver,
  containmentRemedy,
  overrideForSet,
  overrideSlug,
  tierDefaults,
  withConnectEnv,
  type ContainmentRemedy,
  type ManifestChanges,
} from "./manifest-resolver.js";
import type { RegistryServer, TrustTier } from "../registry/types.js";
import type { CapabilityManifest } from "./types.js";

/**
 * mcp_sandbox "set" on a server with no saved override and no live connection
 * (as right after a refused connect) used to start from a fixed l1-process
 * baseline. Asking for registry access only, an unknown server under container
 * isolation came out with no container, so network and files unrestricted, and
 * a registry server lost the env vars it declares. overrideForSet now starts
 * from what a connect would resolve; these pin that down.
 */

const ALL_TIERS: TrustTier[] = ["verified", "trusted", "community", "unknown"];

const GITHUB = {
  slug: "github",
  authDetails: { envVars: [{ name: "GITHUB_TOKEN" }], allEnvVars: [], schemes: [] },
} as unknown as RegistryServer;

const REGISTRY_ONLY: ManifestChanges = { network: "allowlist", networkAllow: ["registry.npmjs.org"] };

function manifest(over: Partial<CapabilityManifest> = {}): CapabilityManifest {
  return {
    version: 1,
    slug: "srv",
    enforcement: "l2-container",
    env: { allow: ["API_KEY"], inheritDefaults: true },
    network: { mode: "none", allow: [] },
    filesystem: { read: ["/data"], write: [] },
    subprocess: false,
    limits: { maxMemoryMb: 256 },
    ...over,
  };
}

describe("tierDefaults", () => {
  it("puts community and unknown in a container under isolation, and leaves verified and trusted on L1", () => {
    const enforcement = (t: TrustTier, containerIsolation: boolean) =>
      tierDefaults("s", t, { containerIsolation }).enforcement;
    expect(ALL_TIERS.map((t) => enforcement(t, true))).toEqual([
      "l1-process",
      "l1-process",
      "l2-container",
      "l2-container",
    ]);
    expect(ALL_TIERS.map((t) => enforcement(t, false))).toEqual(Array(4).fill("l1-process"));
  });

  it("gives unknown no network and no subprocesses", () => {
    const m = tierDefaults("s", "unknown", { containerIsolation: true });
    expect(m.network).toEqual({ mode: "none", allow: [] });
    expect(m.subprocess).toBe(false);
  });

  it("allows the auth env vars the registry record declares, and nothing else", () => {
    const m = tierDefaults("s", "community", { containerIsolation: false, registryServer: GITHUB });
    expect(m.env).toEqual({ allow: ["GITHUB_TOKEN"], inheritDefaults: true });
  });

  it("is what ManifestResolver.resolve returns for a server with no saved override, before connect env", () => {
    const missing = join(tmpdir(), `mcp-gateway-no-such-manifests-${process.pid}.json`);
    for (const containerIsolation of [true, false]) {
      const resolver = new ManifestResolver(missing, containerIsolation);
      for (const t of ALL_TIERS) {
        const defaults = tierDefaults("s", t, { containerIsolation, registryServer: GITHUB });
        expect(resolver.resolve("s", t, GITHUB)).toEqual(defaults);
        expect(resolver.resolve("s", t, GITHUB, ["EXTRA"])).toEqual(withConnectEnv(defaults, ["EXTRA"]));
      }
    }
  });
});

/**
 * A saved override used to be applied as saved, without the env names passed
 * to mcp_connect. Their values still reached a server at L1, but under L2
 * only names in env.allow are forwarded into the container, so a contained
 * server with an override never received what the user handed it.
 */
describe("withConnectEnv", () => {
  it("allows the names passed to the connect, once each, after the ones already allowed", () => {
    const m = withConnectEnv(manifest(), ["EXTRA", "API_KEY", "EXTRA"]);
    expect(m.env).toEqual({ allow: ["API_KEY", "EXTRA"], inheritDefaults: true });
  });

  it("returns the manifest itself when there is nothing to add, and never changes it", () => {
    const saved = manifest();
    expect(withConnectEnv(saved, ["API_KEY"])).toBe(saved);
    withConnectEnv(saved, ["EXTRA"]);
    expect(saved.env.allow).toEqual(["API_KEY"]);
  });
});

describe("ManifestResolver.resolve with a saved override", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "mcp-gateway-manifests-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("allows the env names passed to this connect, without saving them into the override", () => {
    const file = join(dir, "manifests.json");
    const resolver = new ManifestResolver(file, true);
    resolver.saveOverride(manifest({ env: { allow: [], inheritDefaults: true } }));

    expect(resolver.resolve("srv", "unknown", null, ["API_KEY"]).env.allow).toEqual(["API_KEY"]);
    // The next connect, and mcp_sandbox "set", still see the override as saved.
    expect(resolver.resolve("srv", "unknown", null).env.allow).toEqual([]);
    expect(resolver.getOverride("srv")?.env.allow).toEqual([]);
    expect(new ManifestResolver(file, true).getOverride("srv")?.env.allow).toEqual([]);
  });

  it("lists overrides filed under a registry name, from the file, until each is cleared", () => {
    const file = join(dir, "manifests.json");
    const resolver = new ManifestResolver(file, true);
    // What mcp_sandbox "set" by name saved before it resolved names to slugs.
    resolver.saveOverride(manifest({ slug: "io.github.acme/srv" }));
    resolver.saveOverride(manifest({ slug: "srv" }));

    const reloaded = new ManifestResolver(file, true);
    expect(reloaded.nameKeyedOverrides()).toEqual(["io.github.acme/srv"]);
    // A connect never applies it: connects look overrides up by slug.
    expect(reloaded.resolve("io-github-acme-srv", "unknown")).toEqual(
      tierDefaults("io-github-acme-srv", "unknown", { containerIsolation: true }),
    );
    reloaded.clearOverride("io.github.acme/srv");
    expect(new ManifestResolver(file, true).nameKeyedOverrides()).toEqual([]);
  });
});

describe("overrideForSet", () => {
  it("keeps the container when only the network changes on a server with no override (the reported case)", () => {
    const { manifest: m, start } = overrideForSet(
      "npx-server-everything",
      REGISTRY_ONLY,
      { lookup: { status: "not-found" } },
      true,
    );
    expect(m.enforcement).toBe("l2-container");
    expect(m.network).toEqual({ mode: "allowlist", allow: ["registry.npmjs.org"] });
    expect(m.slug).toBe("npx-server-everything");
    expect(start).toEqual({ from: "defaults", trustTier: "unknown", lookup: "not-found" });
  });

  it("keeps the env vars the registry declares when only the network changes", () => {
    const { manifest: m, start } = overrideForSet(
      "github",
      REGISTRY_ONLY,
      { lookup: { status: "found", server: GITHUB, trustTier: "community" } },
      true,
    );
    expect(m.env.allow).toEqual(["GITHUB_TOKEN"]);
    expect(m.enforcement).toBe("l2-container");
    expect(start).toEqual({ from: "defaults", trustTier: "community", lookup: "found" });
  });

  it("with no changes, saves exactly what a connect would resolve", () => {
    for (const t of ALL_TIERS) {
      const { manifest: m } = overrideForSet(
        "github",
        {},
        { lookup: { status: "found", server: GITHUB, trustTier: t } },
        true,
      );
      expect(m).toEqual(tierDefaults("github", t, { containerIsolation: true, registryServer: GITHUB }));
    }
  });

  it("follows the registry's tier rather than locking down a server it trusts", () => {
    const { manifest: m } = overrideForSet(
      "github",
      {},
      { lookup: { status: "found", server: GITHUB, trustTier: "verified" } },
      true,
    );
    expect(m.enforcement).toBe("l1-process");
    expect(m.network.mode).toBe("all");
  });

  it("treats a slug the registry couldn't be asked about as unknown, the most locked-down tier", () => {
    for (const lookup of [{ status: "unreachable" } as const, undefined]) {
      const { manifest: m, start } = overrideForSet("github", {}, { lookup }, true);
      expect(m).toEqual(tierDefaults("github", "unknown", { containerIsolation: true }));
      expect(start).toEqual({ from: "defaults", trustTier: "unknown", lookup: "unreachable" });
    }
  });

  it("changes a saved override in place, ahead of a live connection's tier and the registry", () => {
    const saved = manifest();
    const { manifest: m, start } = overrideForSet(
      "srv",
      REGISTRY_ONLY,
      { saved, lookup: { status: "connection", trustTier: "verified", server: GITHUB } },
      false,
    );
    expect(start).toEqual({ from: "override" });
    expect(m).toEqual({ ...saved, network: { mode: "allowlist", allow: ["registry.npmjs.org"] } });
    expect(saved.network.mode).toBe("none");
  });

  /**
   * A live connection's own manifest is no base for an override: it allows
   * the env names passed to that connect (which every later connect would
   * then allow too, from the gateway's environment), it may run at L1 for want
   * of an engine, and it may come from an override since reset. So set takes
   * only the connection's tier and registry record, and builds the defaults.
   */
  it("builds a live connection's override on its tier's defaults and declared env vars", () => {
    const { manifest: m, start } = overrideForSet(
      "github",
      REGISTRY_ONLY,
      { lookup: { status: "connection", trustTier: "community", server: GITHUB } },
      true,
    );
    expect(m).toEqual({
      ...tierDefaults("github", "community", { containerIsolation: true, registryServer: GITHUB }),
      network: { mode: "allowlist", allow: ["registry.npmjs.org"] },
    });
    expect(m.env.allow).toEqual(["GITHUB_TOKEN"]);
    expect(start).toEqual({ from: "defaults", trustTier: "community", lookup: "connection" });
  });

  it("takes the tier a connection was given, as a command connect's unknown with no record", () => {
    const { manifest: m } = overrideForSet(
      "npx-srv",
      {},
      { lookup: { status: "connection", trustTier: "unknown", server: null } },
      true,
    );
    expect(m).toEqual(tierDefaults("npx-srv", "unknown", { containerIsolation: true }));
  });

  it("takes the tier the latest connect attempt worked out, as for a live connection", () => {
    // A command whose package MCP Rating rates: the connect judged it as the package.
    const { manifest: m, start } = overrideForSet(
      "npx-srv",
      {},
      { lookup: { status: "last-connect", trustTier: "trusted", server: null } },
      true,
    );
    expect(m).toEqual(tierDefaults("npx-srv", "trusted", { containerIsolation: true }));
    expect(start).toEqual({ from: "defaults", trustTier: "trusted", lookup: "last-connect" });
  });

  it("keeps the container for a server whose connection fell back to L1, since its defaults ask for one", () => {
    const lookup = { status: "connection", trustTier: "unknown", server: null } as const;
    expect(overrideForSet("srv", REGISTRY_ONLY, { lookup }, true).manifest.enforcement).toBe("l2-container");
    // An explicit l1-process is still saved as asked.
    expect(
      overrideForSet("srv", { enforcement: "l1-process" }, { lookup }, true).manifest.enforcement,
    ).toBe("l1-process");
  });

  it("applies every field it is given, an empty list included", () => {
    const { manifest: m } = overrideForSet(
      "srv",
      {
        enforcement: "l1-process",
        network: "all",
        networkAllow: [],
        envAllow: [],
        fsRead: [],
        fsWrite: ["/out"],
        subprocess: true,
      },
      { saved: manifest() },
      true,
    );
    expect(m).toMatchObject({
      enforcement: "l1-process",
      env: { allow: [], inheritDefaults: true },
      network: { mode: "all", allow: [] },
      filesystem: { read: [], write: ["/out"] },
      subprocess: true,
    });
  });
});

/**
 * The summary of a server outside a container ends its Files line with what
 * would contain it, and used to say "set MCP_GATEWAY_CONTAINER_ISOLATION=true"
 * every time: also where that was already on, for a verified server or one
 * that fell back to L1 for want of Docker or Podman, and where a saved
 * override decides the enforcement whatever the setting says.
 */
describe("containmentRemedy", () => {
  const L1 = manifest({ enforcement: "l1-process" });
  const remedy = (over: Partial<Parameters<typeof containmentRemedy>[0]>) =>
    containmentRemedy({
      resolved: L1,
      trustTier: "community",
      containerIsolation: false,
      hasOverride: false,
      ...over,
    });

  it("asks for an engine when the manifest wanted a container, whatever else holds", () => {
    for (const trustTier of ALL_TIERS) {
      for (const containerIsolation of [true, false]) {
        for (const hasOverride of [true, false]) {
          expect(remedy({ resolved: manifest(), trustTier, containerIsolation, hasOverride })).toBe("start-engine");
        }
      }
    }
  });

  it("suggests the isolation setting only for the tiers it escalates", () => {
    expect(ALL_TIERS.map((trustTier) => remedy({ trustTier }))).toEqual([
      "set-enforcement",
      "set-enforcement",
      "enable-isolation",
      "enable-isolation",
    ]);
  });

  it("never suggests the setting when it is already on, or when a saved override decides", () => {
    for (const trustTier of ALL_TIERS) {
      expect(remedy({ trustTier, containerIsolation: true })).toBe("set-enforcement");
      expect(remedy({ trustTier, hasOverride: true })).toBe("set-enforcement");
    }
  });
});

describe("ManifestResolver.summarize", () => {
  const L1 = manifest({ enforcement: "l1-process" });
  const files = (m: CapabilityManifest, remedy?: ContainmentRemedy) =>
    ManifestResolver.summarize(m, remedy).lines.find((l) => l.startsWith("Files:"));

  it("ends an uncontained server's Files line with what would contain it", () => {
    expect(files(L1, "start-engine")).toContain("no Docker or Podman was found; start one and reconnect to restrict");
    expect(files(L1, "enable-isolation")).toContain("(set MCP_GATEWAY_CONTAINER_ISOLATION=true to restrict)");
    expect(files(L1, "set-enforcement")).toContain(
      'mcp_sandbox({action: "set", slug: "srv", enforcement: "l2-container"})',
    );
  });

  it("names the isolation setting only when turning it on would help", () => {
    for (const r of [undefined, "start-engine", "set-enforcement"] as const) {
      expect(files(L1, r)).not.toContain("MCP_GATEWAY_CONTAINER_ISOLATION");
    }
  });

  it("gives a contained server no hint", () => {
    for (const r of ["start-engine", "enable-isolation", "set-enforcement"] as const) {
      expect(files(manifest(), r)).toBe("Files: 1 read path(s), 0 write path(s) mounted; nothing else from the host");
    }
  });
});

/**
 * A connect by registry name knows the server by the registry's slug for it,
 * and looks its override up under that. mcp_sandbox used to file an override
 * under whatever it was passed, so one set by name was never applied.
 */
describe("overrideSlug", () => {
  const NAMED = { ...GITHUB, slug: "io-github-acme-github" } as RegistryServer;

  it("files an override set by registry name under the slug a connect by that name uses", () => {
    expect(
      overrideSlug("io.github.acme/github", { status: "found", server: NAMED, trustTier: "community" }),
    ).toEqual({ slug: "io-github-acme-github" });
  });

  it("uses anything without a \"/\" as given, with no lookup", () => {
    expect(overrideSlug("npx-some-server")).toEqual({ slug: "npx-some-server" });
    expect(overrideSlug("github", { status: "not-found" })).toEqual({ slug: "github" });
  });

  it("refuses a name no registry has, since no connect would use the override", () => {
    const r = overrideSlug("io.github.nobody/none", { status: "not-found" });
    expect(r).toEqual({ error: expect.stringContaining('No registry has a server named "io.github.nobody/none"') });
  });

  it("refuses a name it couldn't look up rather than guess its slug", () => {
    for (const byName of [{ status: "unreachable" } as const, undefined]) {
      expect(overrideSlug("io.github.acme/github", byName)).toEqual({
        error: expect.stringContaining("No registry answered"),
      });
    }
  });
});
