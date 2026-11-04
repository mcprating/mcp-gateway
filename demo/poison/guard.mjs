#!/usr/bin/env node
/**
 * The only `node` on a gateway run's PATH, and the only program. A model told to
 * start something, or just confused, can name any command, and with the human
 * gate off the gateway would run it: `npx -y anything` would fetch and execute a
 * real package. So a run's PATH has this in place of node, nothing for npx or
 * uvx, and it starts our own scripts and refuses the rest. Whatever it refuses
 * goes in the run's log, since a refused launch is still a launch the gateway
 * allowed.
 *
 *   node guard.mjs <blocked log> <script> [args...]     (from the shim run.mjs writes)
 */
import { appendFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const [, , blockedLog, script, ...rest] = process.argv;
const full = script && !script.startsWith("-") ? resolve(script) : "";

const ours = [join(here, "lure-server.mjs"), join(here, "workspace-server.mjs")].includes(full);
const beacon = basename(full) === "beacon.mjs" && dirname(full) === dirname(blockedLog);

if (!ours && !beacon) {
  appendFileSync(blockedLog, JSON.stringify({ args: [script, ...rest] }) + "\n");
  process.exit(1);
}

process.argv = [process.argv[0], full, ...rest];
await import(pathToFileURL(full).href);
