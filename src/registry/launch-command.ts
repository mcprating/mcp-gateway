/**
 * The command that starts a server, from its package declaration in a registry
 * that speaks the official MCP Registry API (server.json `packages[]`).
 *
 * Mirrors registryLaunchCommand in MCP Rating's src/crawler/launch-command.ts,
 * which was checked against the official registry's real declarations. The
 * gateway is a separate package and can't import it; keep the two in step.
 */

export interface RegistryArgument {
  type?: string; // "positional" | "named"
  name?: string;
  value?: string;
  default?: string;
  valueHint?: string;
  isRequired?: boolean;
  format?: string;
  placeholder?: string;
}

export interface RegistryPackageLike {
  registryType: string;
  identifier: string;
  version?: string;
  runtimeHint?: string;
  runtimeArguments?: RegistryArgument[];
  packageArguments?: RegistryArgument[];
  environmentVariables?: Array<{ name?: string; description?: string; isRequired?: boolean; isSecret?: boolean }>;
}

/** Options uvx and npx accept before the package. Anything else there is a package argument. */
const RUNTIME_OPTIONS: Record<string, Set<string>> = {
  uvx: new Set([
    "-p", "--python", "--from", "--with", "--with-editable", "--with-requirements", "-q", "--quiet",
    "-v", "--verbose", "--index", "--index-url", "--extra-index-url", "--default-index", "--refresh",
    "--no-cache", "--offline", "--isolated", "--env-file", "--prerelease", "--python-preference",
    "--native-tls", "--no-config", "--resolution", "--exclude-newer",
  ]),
  npx: new Set(["-y", "--yes", "-p", "--package", "--registry", "-q", "--quiet", "--silent", "--prefer-offline", "--prefer-online"]),
};

/** A value we can put on a command line as-is: no spaces, no {placeholders}. */
const literal = (v: string | undefined): v is string => v !== undefined && v !== "" && !/\s|\{[^}]*\}/.test(v);

/**
 * An argument as words on the command line, or null when the user has to
 * supply it. Flags such as `--stdio` are declared as positional values, so a
 * named argument without a value is one the user fills in.
 */
function render(a: RegistryArgument): string[] | null {
  const named = a.type === "named" || (a.type !== "positional" && !!a.name);
  if (named) {
    const value = a.value ?? a.default;
    return a.name && literal(value) ? [a.name, value] : null;
  }
  const value = a.value ?? a.default ?? (fixedHint(a) ? a.valueHint : undefined);
  return literal(value) ? [value] : null;
}

/** A short word in valueHint with no marks of user input is a fixed subcommand (Scrapling: "mcp"). */
const fixedHint = (a: RegistryArgument) =>
  !a.isRequired && !a.format && !a.placeholder && /^[a-z][a-z0-9-]{0,23}$/.test(a.valueHint ?? "");

/** Arguments as words, or null when a required one needs the user's input — then none are usable. */
function renderAll(list: RegistryArgument[] | undefined): Array<{ arg: RegistryArgument; parts: string[] }> | null {
  const out: Array<{ arg: RegistryArgument; parts: string[] }> = [];
  for (const arg of list ?? []) {
    const parts = render(arg);
    if (parts) out.push({ arg, parts });
    else if (arg.isRequired) return null;
  }
  return out;
}

/**
 * The command a client builds from an npm or PyPI package declaration: runtime,
 * runtime arguments, package, package arguments. A "runtime" argument that
 * isn't one of npx's or uvx's own options is a misfiled package argument
 * (Serena declares `start-mcp-server` there) and goes after the package.
 */
export function registryLaunchCommand(pkg: RegistryPackageLike): string | null {
  const fallback = pkg.registryType === "npm" ? "npx" : pkg.registryType === "pypi" ? "uvx" : null;
  const hinted = !!pkg.runtimeHint && pkg.runtimeHint === fallback;
  const runtime = hinted ? pkg.runtimeHint! : fallback;
  if (!runtime || !pkg.identifier) return null;
  const own = RUNTIME_OPTIONS[runtime];
  const sameAsPackage = (word: string) =>
    word === pkg.identifier || word.startsWith(`${pkg.identifier}@`) || word.startsWith(`${pkg.identifier}==`);
  const before: string[] = [];
  const after: string[] = [];
  for (const { arg, parts } of (hinted ? renderAll(pkg.runtimeArguments) : []) ?? []) {
    if (arg.type === "positional" && sameAsPackage(parts[0])) continue;
    const word = arg.type === "positional" ? parts[0] : arg.name ?? "";
    (own.has(word) ? before : after).push(...parts);
  }
  const pkgWords = (renderAll(pkg.packageArguments) ?? []).flatMap(({ parts }) => parts);
  const repeated = pkgWords.findIndex(sameAsPackage);
  if (repeated >= 0) {
    for (const w of pkgWords.slice(0, repeated)) (own.has(w) ? before : after).push(w);
    after.push(...pkgWords.slice(repeated + 1));
  } else {
    after.push(...pkgWords);
  }
  const packageOption = runtime === "npx" ? ["--package", "-p"] : ["--from"];
  const named = before.some((p, i) => packageOption.includes(p) && before[i + 1] !== undefined);
  return [runtime, ...before, ...(named && after.length ? [] : [pkg.identifier]), ...after].join(" ");
}

/**
 * `docker run` for an OCI package: stdin kept open, removed on exit, and each
 * declared variable forwarded by name (the value comes from the scoped
 * environment, never the command line). Null when a required argument needs
 * the user's input.
 */
export function ociLaunchCommand(pkg: RegistryPackageLike): string | null {
  if (pkg.registryType !== "oci" || !literal(pkg.identifier)) return null;
  const runtimeArgs = renderAll(pkg.runtimeArguments);
  const packageArgs = renderAll(pkg.packageArguments);
  if (!runtimeArgs || !packageArgs) return null;
  const env = (pkg.environmentVariables ?? [])
    .map((e) => e?.name)
    .filter((n): n is string => !!n && /^[A-Za-z_][A-Za-z0-9_]*$/.test(n))
    .flatMap((n) => ["-e", n]);
  const tagged = pkg.identifier.includes(":") || !literal(pkg.version) ? pkg.identifier : `${pkg.identifier}:${pkg.version}`;
  return [
    "docker", "run", "-i", "--rm",
    ...env,
    ...runtimeArgs.flatMap(({ parts }) => parts),
    tagged,
    ...packageArgs.flatMap(({ parts }) => parts),
  ].join(" ");
}
