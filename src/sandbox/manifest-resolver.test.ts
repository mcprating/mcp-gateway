import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, it, expect } from "vitest";
import {
  ManifestResolver,
  overrideForSet,
  tierDefaults,
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

  it("allows the declared auth env vars and the names passed at connect, once each", () => {
    const m = tierDefaults("s", "community", {
      containerIsolation: false,
      registryServer: GITHUB,
      userProvidedEnvKeys: ["GITHUB_TOKEN", "EXTRA"],
    });
    expect(m.env).toEqual({ allow: ["GITHUB_TOKEN", "EXTRA"], inheritDefaults: true });
  });

  it("is what ManifestResolver.resolve returns for a server with no saved override", () => {
    const missing = join(tmpdir(), `mcp-gateway-no-such-manifests-${process.pid}.json`);
    for (const containerIsolation of [true, false]) {
      const resolver = new ManifestResolver(missing, containerIsolation);
      for (const t of ALL_TIERS) {
        expect(resolver.resolve("s", t, GITHUB, ["EXTRA"])).toEqual(
          tierDefaults("s", t, { containerIsolation, registryServer: GITHUB, userProvidedEnvKeys: ["EXTRA"] }),
        );
      }
    }
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

  it("changes a saved override in place, ahead of a live connection and the registry", () => {
    const saved = manifest();
    const { manifest: m, start } = overrideForSet(
      "srv",
      REGISTRY_ONLY,
      {
        saved,
        live: { running: manifest({ enforcement: "l1-process", env: { allow: [], inheritDefaults: true } }) },
        lookup: { status: "found", server: GITHUB, trustTier: "verified" },
      },
      false,
    );
    expect(start).toEqual({ from: "override" });
    expect(m).toEqual({ ...saved, network: { mode: "allowlist", allow: ["registry.npmjs.org"] } });
    expect(saved.network.mode).toBe("none");
  });

  it("starts from the live connection's manifest when nothing is saved", () => {
    const running = manifest({ env: { allow: ["PASSED_AT_CONNECT"], inheritDefaults: true } });
    const { manifest: m, start } = overrideForSet("srv", REGISTRY_ONLY, { live: { running } }, false);
    expect(start).toEqual({ from: "connection" });
    expect(m.enforcement).toBe("l2-container");
    expect(m.env.allow).toEqual(["PASSED_AT_CONNECT"]);
    expect(m.limits).toEqual({ maxMemoryMb: 256 });
  });

  it("builds on the container a connection resolved, not the l1-process it fell back to with no engine", () => {
    // What connect records with no Docker or Podman: the resolved manifest, and
    // a copy at l1-process that the connection actually runs under.
    const resolved = manifest();
    const running = { ...resolved, enforcement: "l1-process" as const };
    const { manifest: m, start } = overrideForSet("srv", REGISTRY_ONLY, { live: { running, resolved } }, true);
    expect(m).toEqual({ ...resolved, network: { mode: "allowlist", allow: ["registry.npmjs.org"] } });
    expect(start).toEqual({
      from: "connection",
      fellBack: { resolved: "l2-container", running: "l1-process" },
    });
  });

  it("still saves l1-process for a fallen-back connection when that is asked for", () => {
    const resolved = manifest();
    const running = { ...resolved, enforcement: "l1-process" as const };
    const { manifest: m } = overrideForSet(
      "srv",
      { enforcement: "l1-process" },
      { live: { running, resolved } },
      true,
    );
    expect(m.enforcement).toBe("l1-process");
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
