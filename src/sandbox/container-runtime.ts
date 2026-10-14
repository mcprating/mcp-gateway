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
  /**
   * Values the caller must add to the spawn env for names this command
   * forwards: the egress proxy URLs, which carry the proxy's credential and so
   * do not belong on a command line other users can read with `ps`.
   */
  env: Record<string, string>;
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

/** Lower-cased, without a Windows .exe/.cmd suffix. */
function commandName(command: string): string {
  return command.toLowerCase().replace(/\.(exe|cmd)$/, "");
}

interface FetchingLauncher {
  /** build-server-image.mjs --runtime that bakes this launcher's packages. */
  runtime: "node" | "python";
  /**
   * Hosts the launcher downloads from, when DEFAULT_IMAGES ship it. Absent
   * when they don't: python:3.12-slim has no uv or pipx, node:22-alpine has no
   * pnpm or bun and its Yarn 1 has no dlx. Then granting network doesn't get
   * the server started; only a baked image does.
   */
  downloadHosts?: string[];
}

/**
 * Launchers that download the server package every time they start, keyed by
 * the command plus the subcommand that does the download.
 */
const FETCHING_LAUNCHERS = new Map<string, FetchingLauncher>([
  ["npx", { runtime: "node", downloadHosts: ["registry.npmjs.org"] }],
  ["npm exec", { runtime: "node", downloadHosts: ["registry.npmjs.org"] }],
  ["npm x", { runtime: "node", downloadHosts: ["registry.npmjs.org"] }],
  ["pnpm dlx", { runtime: "node" }],
  ["yarn dlx", { runtime: "node" }],
  ["bunx", { runtime: "node" }],
  ["uvx", { runtime: "python" }],
  ["uv tool run", { runtime: "python" }],
  ["pipx run", { runtime: "python" }],
]);

interface FetchingLaunch extends FetchingLauncher {
  /** e.g. "npx", "pipx run" */
  launcher: string;
  /** Args after the launcher: its flags, the package, the server's own args. */
  rest: string[];
}

function fetchingLaunch(command: string, args: string[]): FetchingLaunch | null {
  const name = commandName(command);
  for (let n = Math.min(2, args.length); n >= 0; n--) {
    const launcher = [name, ...args.slice(0, n)].join(" ");
    const entry = FETCHING_LAUNCHERS.get(launcher);
    if (entry) return { ...entry, launcher, rest: args.slice(n) };
  }
  return null;
}

/** What build-server-image.mjs accepts as --package; it refuses anything else. */
const BAKEABLE_PACKAGE = /^[@a-z0-9._/-]+$/i;

/**
 * The package a launcher fetches: the value of --package=/--from=/--spec=,
 * else the first positional arg (which `-p pkg` and `--from pkg` also leave
 * first). Null when there is none the build script would accept.
 */
function fetchedPackage(rest: string[]): string | null {
  for (const a of rest) {
    const flagged = /^--(?:package|from|spec)=(.+)$/.exec(a);
    const spec = flagged ? flagged[1] : a.startsWith("-") ? null : a;
    if (spec !== null) return BAKEABLE_PACKAGE.test(spec) ? spec : null;
  }
  return null;
}

const shellArg = (s: string) => (/^[\w@./-]+$/.test(s) ? s : JSON.stringify(s));

/**
 * Why a contained server can't start, when that is knowable before spawning
 * it. Under `network: none` with no baked image, a launcher that downloads its
 * package at start (npx, uvx, pipx run, …) can't reach the registry, and the
 * connect only ends at the handshake timeout with nothing to say why.
 *
 * Returns the explanation with the ways out, or null if nothing stands in the
 * way. `slug` must be the one resolveBakedImage was asked about, so the build
 * command it suggests produces the image the next connect looks for.
 */
export function offlineStartProblem(
  slug: string,
  manifest: CapabilityManifest,
  command: string,
  args: string[],
  bakedImage: BakedImage | null | undefined,
): string | null {
  if (manifest.enforcement !== "l2-container") return null;
  if (manifest.network.mode !== "none" || bakedImage) return null;
  const launch = fetchingLaunch(command, args);
  if (!launch) return null;

  const pkg = fetchedPackage(launch.rest);
  const build = [
    "node scripts/build-server-image.mjs",
    `--slug ${shellArg(slug)}`,
    `--package ${pkg ?? "<package>"}`,
    ...(launch.runtime === "python" ? ["--runtime python"] : []),
  ].join(" ");
  const lines = [
    `\`${launch.launcher}\` downloads ${pkg ?? "the server's package"} when it starts, but this server's sandbox allows no network and there is no pre-built image ${bakedImageName(slug)} with the package in it, so the gateway did not start it.`,
    "",
  ];

  if (!launch.downloadHosts) {
    lines.push(
      `Allowing network would not help: the container's base image, ${selectImage(command)}, has no \`${launch.launcher}\`. Build the image once, from a clone of the mcp-gateway repo, then call mcp_connect again. The server then runs with no network at all:`,
      `   ${build}`,
    );
    return lines.join("\n");
  }

  // mcp_sandbox "set" on a server with no saved override starts from an
  // l1-process baseline with no env grants, so spell out what must survive:
  // the container, and the env names this server was already allowed.
  const hosts = launch.downloadHosts;
  const sandboxArgs = [
    `action: "set"`,
    `slug: ${JSON.stringify(slug)}`,
    `enforcement: "l2-container"`,
    `network: "allowlist"`,
    `networkAllow: ${JSON.stringify(hosts)}`,
    ...(manifest.env.allow.length > 0 ? [`envAllow: ${JSON.stringify(manifest.env.allow)}`] : []),
  ];
  lines.push(
    "Either, then call mcp_connect again:",
    "1. Build the image once, from a clone of the mcp-gateway repo. The server then runs with no network at all:",
    `   ${build}`,
    `2. Or let this server reach ${hosts.join(", ")}, still inside its container:`,
    `   mcp_sandbox({${sandboxArgs.join(", ")}})`,
  );
  return lines.join("\n");
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
  const c = commandName(command);
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
  // the first non-flag arg (e.g. "@scope/pkg") after any launcher subcommand
  // (`pipx run`, `npm exec`); npx flags like -y precede it.
  const rest = fetchingLaunch(command, args)?.rest ?? args;
  const pkgIdx = rest.findIndex((a) => !a.startsWith("-"));
  const passThrough = pkgIdx >= 0 ? rest.slice(pkgIdx + 1) : [];
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
  const env: Record<string, string> = {};
  const forwardedEnvNames: string[] = [];

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
        // Forwarded by name: the URL carries the proxy's credential.
        for (const name of ["HTTPS_PROXY", "HTTP_PROXY", "https_proxy", "http_proxy"]) {
          runArgs.push("-e", name);
          forwardedEnvNames.push(name);
          env[name] = opts.egressProxyUrl;
        }
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

  return { command: engine, args: runArgs, forwardedEnvNames, env };
}
