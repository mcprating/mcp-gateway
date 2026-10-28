#!/usr/bin/env node
/**
 * Stand in for `npx` when the gateway starts a server, during a measurement.
 *
 *   node demo/replay-npx.mjs <fixture.json> <packages.json> <log> -- <npx args...>
 *
 * claude-code-whole-bill.mjs puts an `npx` wrapper calling this first on the
 * gateway's PATH. When the gateway runs `npx -y <package>`, this looks the
 * package up in packages.json ({ slug: { npm } }) and serves that server's
 * stored tool list with replay-tools-server.mjs. A package it doesn't know is
 * refused, never fetched: the measurement runs no third-party code.
 *
 * Paths come as arguments, not environment variables, because the gateway
 * scopes a server's environment and would strip them.
 */
import { appendFileSync, readFileSync } from "node:fs";

const argv = process.argv.slice(2);
const sep = argv.indexOf("--");
const [fixture, packagesPath, log] = argv.slice(0, sep);
const npxArgs = argv.slice(sep + 1);

// The package is the first argument that isn't a flag; drop any @version.
const spec = npxArgs.find((a) => !a.startsWith("-")) ?? "";
const pkg = spec.lastIndexOf("@") > 0 ? spec.slice(0, spec.lastIndexOf("@")) : spec;

const packages = JSON.parse(readFileSync(packagesPath, "utf8"));
const slug = Object.keys(packages).find((s) => packages[s].npm === pkg);
appendFileSync(log, `${new Date().toISOString()} npx ${npxArgs.join(" ")} -> ${slug ?? "REFUSED"}\n`);

if (!slug) {
  console.error(`replay-npx: "${pkg}" is not replayed in this measurement, and no package is fetched.`);
  process.exit(1);
}

process.argv = [process.argv[0], "replay-tools-server.mjs", fixture, slug];
await import(new URL("./replay-tools-server.mjs", import.meta.url).href);
