import { execFileSync } from "node:child_process";
import { log } from "../utils/logger.js";

/**
 * Where to get the runtimes registry entries most often launch with. The
 * message reaches the model as the connect result, so it has to say what to
 * install rather than just that something failed.
 */
const INSTALL_HINTS: Record<string, string> = {
  uv: "Install uv: https://docs.astral.sh/uv/getting-started/installation/",
  uvx: "Install uv (it provides uvx): https://docs.astral.sh/uv/getting-started/installation/",
  docker: "Install Docker: https://docs.docker.com/get-docker/",
  podman: "Install Podman: https://podman.io/docs/installation",
  python: "Install Python: https://www.python.org/downloads/",
  python3: "Install Python: https://www.python.org/downloads/",
  pip: "Install Python (pip ships with it): https://www.python.org/downloads/",
  pip3: "Install Python (pip ships with it): https://www.python.org/downloads/",
  pipx: "Install pipx: https://pipx.pypa.io/stable/installation/",
  deno: "Install Deno: https://docs.deno.com/runtime/getting_started/installation/",
  bun: "Install Bun: https://bun.sh/docs/installation",
  bunx: "Install Bun (it provides bunx): https://bun.sh/docs/installation",
  node: "Install Node.js: https://nodejs.org/",
  npx: "Install Node.js (it provides npx): https://nodejs.org/",
  go: "Install Go: https://go.dev/doc/install",
};

/** The error a connect returns when the server's launcher is not installed. */
export function missingCommandMessage(command: string): string {
  const hint = INSTALL_HINTS[command.toLowerCase()] ?? `Install "${command}" and make sure it is on PATH.`;
  return `"${command}" is not installed on this machine, so this server cannot start. ${hint} Then connect again.`;
}

/**
 * Make sure a server's launcher can run before spawning it.
 *
 * `npx` gains `-y`, because without it npx stops at an install prompt that no
 * MCP client will ever answer. Any other command must already be on PATH.
 *
 * There is deliberately no fallback when it is not. This used to rewrite a
 * missing command to `npx -y <command>` whenever the name looked like an npm
 * package — which every launcher name does. On a machine without Docker,
 * `docker run …` then downloaded and ran the unrelated npm package called
 * `docker`: somebody else's code, in place of the one the registry named, in a
 * gateway whose whole job is not doing that. A missing runtime is the user's to
 * install; the gateway's job is to say which one.
 */
export async function ensureInstalled(
  command: string,
  args: string[],
): Promise<{ command: string; args: string[] }> {
  if (command === "npx") {
    if (!args.includes("-y") && !args.includes("--yes")) {
      log.debug("Adding -y flag to npx command for auto-install", { args });
      return { command, args: ["-y", ...args] };
    }
    return { command, args };
  }

  if (!isCommandAvailable(command)) {
    log.warn("Command not found on PATH", { command });
    throw new Error(missingCommandMessage(command));
  }

  return { command, args };
}

/**
 * Is `command` on PATH?
 *
 * execFile, never a shell string: the command comes from registry data, and
 * `which ${command}` through a shell would run anything appended to it.
 */
export function isCommandAvailable(command: string): boolean {
  try {
    const finder = process.platform === "win32" ? "where" : "which";
    execFileSync(finder, [command], { timeout: 5_000, stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}
