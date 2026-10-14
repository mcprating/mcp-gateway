import { describe, it, expect } from "vitest";
import {
  bakedImageName,
  buildContainerCommand,
  offlineStartProblem,
} from "./container-runtime.js";
import type { CapabilityManifest } from "./types.js";

/**
 * An unknown server under container isolation gets `network: none`. Started
 * with npx and no baked image, it can't download its package, and the connect
 * used to end 30s later with only "Timed out connecting". offlineStartProblem
 * is the decision to refuse up front instead, and the text the user then
 * acts on; a wrong command in that text is a dead end with better manners.
 */

function manifest(over: Partial<CapabilityManifest> = {}): CapabilityManifest {
  return {
    version: 1,
    slug: "npx-server-everything",
    enforcement: "l2-container",
    env: { allow: [], inheritDefaults: true },
    network: { mode: "none", allow: [] },
    filesystem: { read: [], write: [] },
    subprocess: false,
    ...over,
  };
}

const EVERYTHING = ["-y", "@modelcontextprotocol/server-everything"];

describe("offlineStartProblem", () => {
  it("refuses npx under network:none with no baked image, and names both ways out", () => {
    const msg = offlineStartProblem("npx-server-everything", manifest(), "npx", EVERYTHING, null);
    expect(msg).toContain("`npx` downloads @modelcontextprotocol/server-everything");
    expect(msg).toContain("mcp-sandbox/npx-server-everything:latest");
    expect(msg).toContain(
      "node scripts/build-server-image.mjs --slug npx-server-everything --package @modelcontextprotocol/server-everything",
    );
    expect(msg).toContain(
      'mcp_sandbox({action: "set", slug: "npx-server-everything", enforcement: "l2-container", network: "allowlist", networkAllow: ["registry.npmjs.org"]})',
    );
  });

  it("keeps the container in the network way out, since set without an override falls back to l1-process", () => {
    const msg = offlineStartProblem("s", manifest(), "npx", EVERYTHING, undefined);
    expect(msg).toContain('enforcement: "l2-container"');
  });

  it("carries the server's env grants into the mcp_sandbox call, which would otherwise drop them", () => {
    const m = manifest({ env: { allow: ["GITHUB_TOKEN"], inheritDefaults: true } });
    expect(offlineStartProblem("s", m, "npx", EVERYTHING, null)).toContain('envAllow: ["GITHUB_TOKEN"]');
    expect(offlineStartProblem("s", manifest(), "npx", EVERYTHING, null)).not.toContain("envAllow");
  });

  it("says nothing when a baked image exists, even one without a bin label", () => {
    const baked = { image: bakedImageName("s"), bin: null };
    expect(offlineStartProblem("s", manifest(), "npx", EVERYTHING, baked)).toBeNull();
    expect(offlineStartProblem("s", manifest(), "npx", EVERYTHING, { ...baked, bin: "x" })).toBeNull();
  });

  it("says nothing when the server may reach the network", () => {
    for (const mode of ["allowlist", "all"] as const) {
      const m = manifest({ network: { mode, allow: [] } });
      expect(offlineStartProblem("s", m, "npx", EVERYTHING, null)).toBeNull();
    }
  });

  it("says nothing outside a container, where network:none is not enforced", () => {
    for (const enforcement of ["none", "l1-process"] as const) {
      expect(offlineStartProblem("s", manifest({ enforcement }), "npx", EVERYTHING, null)).toBeNull();
    }
  });

  it("says nothing for commands that don't download at start", () => {
    const m = manifest();
    expect(offlineStartProblem("s", m, "node", ["server.js"], null)).toBeNull();
    expect(offlineStartProblem("s", m, "python", ["-m", "my_server"], null)).toBeNull();
    expect(offlineStartProblem("s", m, "npm", ["start"], null)).toBeNull();
    expect(offlineStartProblem("s", m, "uv", ["run", "server.py"], null)).toBeNull();
    expect(offlineStartProblem("s", m, "pipx", [], null)).toBeNull();
  });

  it("recognises the Windows shims", () => {
    expect(offlineStartProblem("s", manifest(), "NPX.cmd", EVERYTHING, null)).toContain("`npx` downloads");
    expect(offlineStartProblem("s", manifest(), "uvx.exe", ["mcp-server-time"], null)).toContain("`uvx` downloads");
  });

  it("offers only the bake for uvx, because the python base image has no uvx to give network to", () => {
    const msg = offlineStartProblem("uvx-mcp-server-time", manifest(), "uvx", ["mcp-server-time"], null);
    expect(msg).toContain(
      "node scripts/build-server-image.mjs --slug uvx-mcp-server-time --package mcp-server-time --runtime python",
    );
    expect(msg).toContain("python:3.12-slim, has no `uvx`");
    expect(msg).not.toContain("mcp_sandbox(");
  });

  it("takes the package after a launcher's subcommand, not the subcommand itself", () => {
    const m = manifest();
    expect(offlineStartProblem("s", m, "pipx", ["run", "mcp-server-time"], null)).toContain(
      "--package mcp-server-time --runtime python",
    );
    expect(offlineStartProblem("s", m, "uv", ["tool", "run", "mcp-server-time"], null)).toContain(
      "--package mcp-server-time --runtime python",
    );
    const npmExec = offlineStartProblem("s", m, "npm", ["exec", "-y", "--", "@scope/pkg"], null);
    expect(npmExec).toContain("--package @scope/pkg");
    expect(npmExec).toContain('networkAllow: ["registry.npmjs.org"]');
  });

  it("reads the package from --package= and --from= when the positional is the bin", () => {
    const m = manifest();
    expect(offlineStartProblem("s", m, "npx", ["--package=@scope/pkg", "pkg-bin"], null)).toContain(
      "--package @scope/pkg",
    );
    expect(offlineStartProblem("s", m, "uvx", ["--from=mcp-server-git", "mcp-server-git"], null)).toContain(
      "--package mcp-server-git",
    );
  });

  it("leaves a placeholder rather than a spec the build script would refuse", () => {
    const msg = offlineStartProblem("s", manifest(), "uvx", ["--from", "git+https://github.com/o/r", "srv"], null);
    expect(msg).toContain("--package <package>");
    expect(msg).not.toContain("git+https");
  });

  it("suggests the slug the gateway looks the image up by, quoted only when a shell needs it", () => {
    const registrySlug = "@modelcontextprotocol/server-everything";
    const msg = offlineStartProblem(registrySlug, manifest(), "npx", EVERYTHING, null);
    expect(msg).toContain(`--slug ${registrySlug} `);
    expect(msg).toContain(bakedImageName(registrySlug));
    expect(offlineStartProblem("odd slug", manifest(), "npx", EVERYTHING, null)).toContain('--slug "odd slug"');
  });
});

describe("buildContainerCommand with a baked image", () => {
  const baked = { image: "mcp-sandbox/s:latest", bin: "srv-bin" };
  const tail = (command: string, args: string[]) => {
    const run = buildContainerCommand("docker", manifest(), command, args, { bakedImage: baked }).args;
    return run.slice(run.indexOf(baked.image) + 1);
  };

  it("runs the bin with the args that followed the package", () => {
    expect(tail("npx", ["-y", "@scope/pkg", "--root", "/data"])).toEqual(["srv-bin", "--root", "/data"]);
    expect(tail("uvx", ["mcp-server-time", "--local-timezone", "UTC"])).toEqual([
      "srv-bin",
      "--local-timezone",
      "UTC",
    ]);
  });

  it("does not hand a launcher subcommand's package to the bin as an argument", () => {
    // Previously `run` was taken as the package, so the bin got
    // `mcp-server-time` as its first argument.
    expect(tail("pipx", ["run", "mcp-server-time", "--local-timezone", "UTC"])).toEqual([
      "srv-bin",
      "--local-timezone",
      "UTC",
    ]);
    expect(tail("npm", ["exec", "-y", "--", "@scope/pkg", "--flag"])).toEqual(["srv-bin", "--flag"]);
  });
});
