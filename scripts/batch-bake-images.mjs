#!/usr/bin/env node
/**
 * Batch-bake pre-baked sandbox images for the top-quality MCP servers.
 *
 * Fetches the highest-scoring servers from the MCP Rating registry and builds a
 * `mcp-sandbox/<slug>:latest` image for each, so the gateway can run them with
 * `network: none` (fully offline) on the next connection.
 *
 * Usage:
 *   node scripts/batch-bake-images.mjs [--limit 25] [--min-score 60]
 *                                      [--registry http://localhost:3000/api/v1]
 *                                      [--concurrency 2] [--dry-run]
 *
 * Notes:
 *  - Images are tagged with the REGISTRY slug, matching mcp_connect({slug}).
 *  - Already-built images are skipped (idempotent / resumable).
 *  - Only servers with a resolvable npm/python package are bakeable.
 */
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const execFileAsync = promisify(execFile);
const __dirname = dirname(fileURLToPath(import.meta.url));
const BUILD_SCRIPT = join(__dirname, "build-server-image.mjs");

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
const flag = (name) => process.argv.includes(`--${name}`);

const limit = parseInt(arg("limit", "25"), 10);
const minScore = parseInt(arg("min-score", "60"), 10);
const registry = arg("registry", "http://localhost:3000/api/v1");
const concurrency = Math.max(1, parseInt(arg("concurrency", "2"), 10));
const dryRun = flag("dry-run");

/**
 * Determine the runtime + package to install from a registry server record.
 * Returns null when the server can't be baked (no resolvable package).
 */
function resolvePackage(server) {
  if (server.npmPackage) {
    return { runtime: "node", pkg: server.npmPackage };
  }
  const install = (server.installCommand || "").trim();
  if (!install) return null;
  const parts = install.split(/\s+/);
  const cmd = (parts[0] || "").toLowerCase();
  // First token after the command that isn't a flag is the package.
  const pkgToken = parts.slice(1).find((p) => !p.startsWith("-"));
  if (!pkgToken) return null;
  if (cmd === "uvx" || cmd === "uv" || cmd === "pip" || cmd === "pipx") {
    return { runtime: "python", pkg: pkgToken };
  }
  if (cmd === "npx") {
    return { runtime: "node", pkg: pkgToken };
  }
  return null;
}

/** Image already built locally? */
function imageExists(slug) {
  const safe = slug.replace(/[^a-z0-9_.-]/gi, "-").toLowerCase();
  const tag = `mcp-sandbox/${safe}:latest`;
  try {
    execFileSync("docker", ["image", "inspect", tag], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

async function bakeOne(server) {
  const resolved = resolvePackage(server);
  if (!resolved) return { slug: server.slug, status: "skipped", reason: "no package" };
  if (imageExists(server.slug)) return { slug: server.slug, status: "exists" };
  if (dryRun) return { slug: server.slug, status: "would-build", ...resolved };

  try {
    await execFileAsync(
      "node",
      [
        BUILD_SCRIPT,
        "--slug", server.slug,
        "--package", resolved.pkg,
        "--runtime", resolved.runtime,
      ],
      { timeout: 300_000 },
    );
    return { slug: server.slug, status: "built", ...resolved };
  } catch (err) {
    return {
      slug: server.slug,
      status: "failed",
      reason: (err.stderr || err.message || String(err)).split("\n")[0],
    };
  }
}

/** Simple promise pool. */
async function runPool(items, worker, size) {
  const results = [];
  let idx = 0;
  async function next() {
    while (idx < items.length) {
      const i = idx++;
      results[i] = await worker(items[i]);
      const r = results[i];
      console.log(`  [${i + 1}/${items.length}] ${r.status.padEnd(11)} ${r.slug}${r.reason ? ` — ${r.reason}` : ""}`);
    }
  }
  await Promise.all(Array.from({ length: size }, next));
  return results;
}

async function main() {
  console.log(`\n🐳 Batch-baking top ${limit} MCP servers (min score ${minScore})\n`);
  console.log(`   registry: ${registry}`);
  console.log(`   concurrency: ${concurrency}${dryRun ? "  (DRY RUN)" : ""}\n`);

  const url = `${registry}/servers?sort=quality&limit=${limit}&minScore=${minScore}`;
  const res = await fetch(url);
  if (!res.ok) {
    console.error(`Failed to fetch registry: HTTP ${res.status}`);
    process.exit(1);
  }
  const data = await res.json();
  const servers = (data.data || []).filter((s) => (s.qualityScore ?? 0) >= minScore);
  console.log(`Fetched ${servers.length} eligible servers.\n`);

  const results = await runPool(servers, bakeOne, concurrency);

  // Summary
  const by = (status) => results.filter((r) => r.status === status).length;
  console.log("\n==================================================");
  console.log("Summary:");
  console.log(`  built:       ${by("built")}`);
  console.log(`  exists:      ${by("exists")}`);
  console.log(`  would-build: ${by("would-build")}`);
  console.log(`  skipped:     ${by("skipped")}`);
  console.log(`  failed:      ${by("failed")}`);
  console.log("==================================================");

  const failed = results.filter((r) => r.status === "failed");
  if (failed.length) {
    console.log("\nFailures:");
    for (const f of failed) console.log(`  ${f.slug}: ${f.reason}`);
  }
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
