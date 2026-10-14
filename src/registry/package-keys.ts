import type { RegistryServer } from "./types.js";

/**
 * Keys that say what a server runs, for MCP Rating's GET /servers/lookup:
 * npm:<package>, pypi:<package>, oci:<namespace/image>, remote:<url>, and
 * name:<registry name>. Mirrors MCP Rating's src/db/package-keys.ts — the two
 * must build identical keys; keep them in step.
 */

const pypiNorm = (name: string) => name.toLowerCase().replace(/[-_.]+/g, "-");

export function ociKey(image: string): string | null {
  let s = image.trim().toLowerCase().replace(/@sha256:[0-9a-f]+$/, "");
  s = s.replace(/^(docker\.io|index\.docker\.io|registry-1\.docker\.io)\//, "");
  const lastSlash = s.lastIndexOf("/");
  const colon = s.indexOf(":", lastSlash + 1);
  if (colon >= 0) s = s.slice(0, colon);
  if (/^[^/]+[.:][^/]*\//.test(s)) return `oci:${s}`;
  if (!s.includes("/")) s = `library/${s}`;
  return /^[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*$/.test(s) ? `oci:${s}` : null;
}

export function remoteKey(url: string): string | null {
  try {
    const u = new URL(url.trim());
    if (u.protocol !== "https:" && u.protocol !== "http:") return null;
    return `remote:${u.protocol}//${u.host.toLowerCase()}${u.pathname.replace(/\/+$/, "")}${u.search}`;
  } catch {
    return null;
  }
}

/**
 * The keys for a server found in another registry: what it would run (every
 * package it declares, every endpoint), and its registry name.
 */
export function lookupKeys(server: RegistryServer): { packages: string[]; name: string | null } {
  const packages = new Set<string>();
  const declared = (server.metadata?.packages as Array<{ registryType?: unknown; identifier?: unknown }> | undefined) ?? [];
  for (const p of declared) {
    if (typeof p?.identifier !== "string" || !p.identifier) continue;
    const key =
      p.registryType === "npm"
        ? `npm:${p.identifier.toLowerCase()}`
        : p.registryType === "pypi"
          ? `pypi:${pypiNorm(p.identifier)}`
          : p.registryType === "oci"
            ? ociKey(p.identifier)
            : null;
    if (key) packages.add(key);
  }
  if (server.npmPackage) packages.add(`npm:${server.npmPackage.toLowerCase()}`);
  const remotes = (server.metadata?.remotes as Array<{ url?: unknown }> | undefined) ?? [];
  for (const r of remotes) {
    const key = typeof r?.url === "string" ? remoteKey(r.url) : null;
    if (key) packages.add(key);
  }
  const registryName = server.registryName ?? (server.metadata?.registryName as string | undefined) ?? null;
  return { packages: [...packages], name: registryName ? `name:${registryName.toLowerCase()}` : null };
}
