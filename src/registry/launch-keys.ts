import { ociKey, remoteKey } from "./package-keys.js";

/**
 * The package a launch would run, as MCP Rating lookup keys: `npx [opts] pkg`,
 * `uvx [opts] pkg`, `docker run [opts] image`, or a URL. Anything else — `node
 * server.js`, a local binary — runs no package we can name, and gets no key.
 */

const pypiNorm = (name: string) => name.toLowerCase().replace(/[-_.]+/g, "-");

/** npx options that take a value. `-p/--package` names the package itself. */
const NPX_VALUE = new Set(["-p", "--package", "--registry", "-c", "--call", "--cache", "--userconfig"]);
const UVX_VALUE = new Set([
  "-p", "--python", "--from", "--with", "--with-editable", "--with-requirements", "--index", "--index-url",
  "--extra-index-url", "--default-index", "--env-file", "--prerelease", "--python-preference", "--resolution",
  "--exclude-newer",
]);
/** docker run options that take a value (when not written --opt=value). */
const DOCKER_VALUE = new Set([
  "-e", "--env", "--env-file", "-v", "--volume", "--mount", "--name", "--network", "--net", "-p", "--publish",
  "-u", "--user", "-w", "--workdir", "--entrypoint", "-l", "--label", "--platform", "-m", "--memory", "--cpus",
  "--add-host", "--tmpfs", "--security-opt", "--cap-add", "--cap-drop", "--hostname", "-h", "--restart",
  "--pull", "--ulimit", "--device", "--dns", "--ipc", "--pid", "--shm-size", "--runtime", "--gpus",
]);

/** "@scope/name@1.2" → "@scope/name"; "name@latest" → "name". */
function npmName(spec: string): string | null {
  const m = spec.match(/^(@[^/@\s]+\/[^@\s]+|[^@\s]+)(@.*)?$/);
  return m && !m[1].startsWith(".") && !m[1].includes(":") ? m[1].toLowerCase() : null;
}

/** "scrapling[ai]==0.4" → "scrapling". */
function pypiName(spec: string): string | null {
  const name = spec.replace(/\[.*$/, "").replace(/[=<>!~@;].*$/, "").trim();
  return /^[a-z0-9._-]+$/i.test(name) ? pypiNorm(name) : null;
}

/** The first argument that is neither an option nor an option's value. */
function firstPositional(args: string[], valued: Set<string>): { word: string | null; options: Map<string, string> } {
  const options = new Map<string, string>();
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--") return { word: args[i + 1] ?? null, options };
    if (a.startsWith("-")) {
      const eq = a.indexOf("=");
      if (eq > 0) options.set(a.slice(0, eq), a.slice(eq + 1));
      else if (valued.has(a)) options.set(a, args[++i] ?? "");
      continue;
    }
    return { word: a, options };
  }
  return { word: null, options };
}

export function launchKeys(launch: { command?: string; args?: string[]; url?: string }): string[] {
  if (launch.url) {
    const k = remoteKey(launch.url);
    return k ? [k] : [];
  }
  const cmd = (launch.command ?? "").split(/[\\/]/).pop()!.toLowerCase().replace(/\.(cmd|exe|bat)$/, "");
  const args = launch.args ?? [];
  if (cmd === "npx") {
    const { word, options } = firstPositional(args, NPX_VALUE);
    const spec = options.get("--package") ?? options.get("-p") ?? word;
    const name = spec ? npmName(spec) : null;
    return name ? [`npm:${name}`] : [];
  }
  if (cmd === "uvx" || (cmd === "uv" && args[0] === "tool" && args[1] === "run")) {
    const rest = cmd === "uv" ? args.slice(2) : args;
    const { word, options } = firstPositional(rest, UVX_VALUE);
    const spec = options.get("--from") ?? word;
    const name = spec ? pypiName(spec) : null;
    return name ? [`pypi:${name}`] : [];
  }
  if ((cmd === "docker" || cmd === "podman") && args[0] === "run") {
    const { word } = firstPositional(args.slice(1), DOCKER_VALUE);
    const key = word ? ociKey(word) : null;
    return key ? [key] : [];
  }
  return [];
}
