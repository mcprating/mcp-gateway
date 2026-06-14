import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { log } from "../utils/logger.js";
import type { CapabilityManifest } from "./types.js";

const execFileAsync = promisify(execFile);

/** A container runtime available on the host. */
export type ContainerEngine = "docker" | "podman";

/** Result of wrapping a spawn command for container execution. */
export interface WrappedSpawn {
  command: string;
  args: string[];
  /**
   * Env var NAMES that must be forwarded into the container. The values are
   * supplied via the spawn process env (the scoped env), and `-e NAME` tells
   * the engine to forward them. Kept separate so callers can audit.
   */
  forwardedEnvNames: string[];
}

/** Default base images by command family. Overridable via config. */
export interface ContainerImages {
  /** Image for node/npm/npx-based servers. */
  node: string;
  /** Image for python/pip/uvx-based servers. */
  python: string;
  /** Fallback image for anything else. */
  default: string;
}

export const DEFAULT_IMAGES: ContainerImages = {
  node: "node:22-alpine",
  python: "python:3.12-slim",
  default: "node:22-alpine",
};

let cachedEngine: ContainerEngine | null | undefined;

/**
 * Detect an available container engine (docker preferred, then podman).
 * Result is cached for the process lifetime. Returns null if none is usable.
 */
export async function detectContainerEngine(): Promise<ContainerEngine | null> {
  if (cachedEngine !== undefined) return cachedEngine;

  for (const engine of ["docker", "podman"] as const) {
    try {
      await execFileAsync(engine, ["version", "--format", "{{.Client.Version}}"], {
        timeout: 5_000,
      });
      log.info("Container engine detected", { engine });
      cachedEngine = engine;
      return engine;
    } catch {
      // try next
    }
  }

  log.warn("No container engine (docker/podman) available — L2 isolation unavailable");
  cachedEngine = null;
  return null;
}

/** Reset the cached engine (for tests). */
export function _resetEngineCache(): void {
  cachedEngine = undefined;
}

/** Deterministic image name for a pre-baked server image. */
export function bakedImageName(slug: string): string {
  const safe = slug.replace(/[^a-z0-9_.-]/gi, "-").toLowerCase();
  return `mcp-sandbox/${safe}:latest`;
}

export interface BakedImage {
  image: string;
  /**
   * The executable name baked into the image (from the mcp.sandbox.bin label).
   * Run directly at runtime — npx can't resolve a globally-installed scoped
   * package offline, so we invoke the bin instead.
   */
  bin: string | null;
}

/**
 * Check whether a pre-baked image exists locally for this slug. A baked image
 * has the server package installed at build time, so it runs offline under
 * `network: none` without an npx/uvx fetch.
 *
 * Returns { image, bin } if present, else null.
 */
export async function resolveBakedImage(
  engine: ContainerEngine,
  slug: string,
): Promise<BakedImage | null> {
  const image = bakedImageName(slug);
  try {
    const { stdout } = await execFileAsync(
      engine,
      ["image", "inspect", "--format", '{{index .Config.Labels "mcp.sandbox.bin"}}', image],
      { timeout: 5_000 },
    );
    const bin = stdout.trim() || null;
    log.debug("Using pre-baked server image", { slug, image, bin });
    return { image, bin };
  } catch {
    return null;
  }
}

/**
 * Choose a base image for the given command.
 *  - npx / npm / node / yarn / pnpm  → node image
 *  - uvx / uv / python / python3 / pip → python image
 *  - anything else                     → default image
 */
export function selectImage(
  command: string,
  images: ContainerImages = DEFAULT_IMAGES,
): string {
  const c = command.toLowerCase().replace(/\.(exe|cmd)$/, "");
  if (["npx", "npm", "node", "yarn", "pnpm"].includes(c)) return images.node;
  if (["uvx", "uv", "python", "python3", "pip", "pip3"].includes(c)) return images.python;
  return images.default;
}

/**
 * Build the `docker run` / `podman run` invocation that executes the
 * downstream server inside a constrained container.
 *
 * Pure function (no I/O) so the flag construction is unit-testable without a
 * running engine. The caller supplies the scoped environment separately (via
 * the spawn process env); here we only emit `-e NAME` forwarding flags.
 *
 * Enforcement applied:
 *  - Capabilities dropped (--cap-drop ALL), no privilege escalation
 *  - Read-only root filesystem + tmpfs scratch
 *  - Non-root user
 *  - Memory / CPU limits from manifest.limits
 *  - Network mode from manifest.network
 *  - Read/write mounts from manifest.filesystem
 *  - Env forwarding limited to manifest.env.allow
 */
export interface ContainerBuildOptions {
  images?: ContainerImages;
  /**
   * Egress proxy URL for `network: allowlist` mode. When set, the container is
   * given HTTP(S)_PROXY env vars pointing here and a host.docker.internal
   * mapping so proxy-aware clients route through the gateway's allowlist filter.
   */
  egressProxyUrl?: string;
  /**
   * Pre-baked image (from resolveBakedImage). When set, this image is used
   * instead of a generic base, and the baked bin is run directly (offline) —
   * enabling true `network: none`. npx cannot resolve a globally-installed
   * scoped package offline, so we invoke the bin instead.
   */
  bakedImage?: BakedImage;
}

/**
 * Compute the run command for a pre-baked image. Runs the baked bin directly
 * with any args that followed the package spec in the original invocation.
 * Falls back to the original command if no bin was detected.
 */
function bakedRunCommand(
  baked: BakedImage,
  command: string,
  args: string[],
): { cmd: string; cmdArgs: string[] } {
  if (!baked.bin) {
    // No bin label — best effort: run original command (may fail offline).
    return { cmd: command, cmdArgs: args };
  }
  // Pass through args that came AFTER the package token. The package token is
  // the first non-flag arg (e.g. "@scope/pkg"); npx flags like -y precede it.
  const pkgIdx = args.findIndex((a) => !a.startsWith("-"));
  const passThrough = pkgIdx >= 0 ? args.slice(pkgIdx + 1) : [];
  return { cmd: baked.bin, cmdArgs: passThrough };
}

export function buildContainerCommand(
  engine: ContainerEngine,
  manifest: CapabilityManifest,
  command: string,
  args: string[],
  opts: ContainerBuildOptions = {},
): WrappedSpawn {
  const images = opts.images ?? DEFAULT_IMAGES;
  const runArgs: string[] = ["run", "--rm", "-i"];

  // ── Hardening (always applied) ──────────────────────────────────────────
  runArgs.push("--cap-drop", "ALL");
  runArgs.push("--security-opt", "no-new-privileges");
  runArgs.push("--read-only");
  // Writable scratch space the server can always use.
  runArgs.push("--tmpfs", "/tmp:rw,exec,nosuid,size=128m");
  // Run as a non-root uid:gid. 1000:1000 is the conventional first user.
  runArgs.push("--user", "1000:1000");

  // ── Network ─────────────────────────────────────────────────────────────
  // NOTE: "allowlist" egress filtering requires a proxy/sidecar and is not yet
  // hard-enforced — it currently maps to the default bridge with the intent
  // declared in the manifest. "none" and "all" are enforced.
  switch (manifest.network.mode) {
    case "none":
      runArgs.push("--network", "none");
      break;
    case "allowlist":
      // Route egress through the gateway's allowlist proxy. The container uses
      // the default bridge but only proxy-aware traffic to allowlisted hosts
      // succeeds; the host.docker.internal mapping lets it reach the proxy.
      if (opts.egressProxyUrl) {
        runArgs.push("--add-host", "host.docker.internal:host-gateway");
        runArgs.push("-e", `HTTPS_PROXY=${opts.egressProxyUrl}`);
        runArgs.push("-e", `HTTP_PROXY=${opts.egressProxyUrl}`);
        runArgs.push("-e", `https_proxy=${opts.egressProxyUrl}`);
        runArgs.push("-e", `http_proxy=${opts.egressProxyUrl}`);
        // Don't proxy localhost / the proxy host itself.
        runArgs.push("-e", "NO_PROXY=localhost,127.0.0.1");
      }
      break;
    case "all":
      // default bridge network (egress allowed).
      break;
  }

  // ── Resource limits ─────────────────────────────────────────────────────
  if (manifest.limits?.maxMemoryMb) {
    runArgs.push("--memory", `${manifest.limits.maxMemoryMb}m`);
  }
  if (manifest.limits?.maxCpuPercent) {
    const cpus = Math.max(0.1, manifest.limits.maxCpuPercent / 100);
    runArgs.push("--cpus", cpus.toFixed(2));
  }

  // ── Filesystem mounts ───────────────────────────────────────────────────
  for (const p of manifest.filesystem.read) {
    runArgs.push("-v", `${p}:${p}:ro`);
  }
  for (const p of manifest.filesystem.write) {
    runArgs.push("-v", `${p}:${p}:rw`);
  }

  // ── Writable cache/home redirection ─────────────────────────────────────
  // Under --read-only root, the default HOME (/home/node, /root) and package
  // caches (~/.npm, ~/.cache) are not writable. Redirect them to the tmpfs so
  // npx / uvx can install the server on first run inside the sandbox.
  runArgs.push("-e", "HOME=/tmp");
  runArgs.push("-e", "XDG_CACHE_HOME=/tmp/.cache");
  const image = selectImage(command, images);
  if (image === images.python) {
    runArgs.push("-e", "UV_CACHE_DIR=/tmp/.uv");
    runArgs.push("-e", "PIP_CACHE_DIR=/tmp/.pip");
  } else {
    runArgs.push("-e", "npm_config_cache=/tmp/.npm");
  }

  // ── Environment forwarding (names only; values come from spawn env) ──────
  const forwardedEnvNames: string[] = [];
  for (const name of manifest.env.allow) {
    runArgs.push("-e", name);
    forwardedEnvNames.push(name);
  }

  // ── Image + the actual server command ───────────────────────────────────
  // A pre-baked image already contains the package, so run its bin offline.
  if (opts.bakedImage) {
    const { cmd, cmdArgs } = bakedRunCommand(opts.bakedImage, command, args);
    runArgs.push(opts.bakedImage.image);
    runArgs.push(cmd, ...cmdArgs);
  } else {
    runArgs.push(image);
    runArgs.push(command, ...args);
  }

  return { command: engine, args: runArgs, forwardedEnvNames };
}
