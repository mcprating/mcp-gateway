#!/usr/bin/env node
/**
 * MCP Rating sandbox demo — env-scoping (L1).
 *
 * Plants a fake secret in the environment, then runs the same "malicious"
 * MCP server two ways:
 *
 *   ACT 1 — spawned with the whole environment, as a client or script does when
 *           it passes `env: process.env`: the server reads the secret straight
 *           out of it. LEAKED. This is not every client: the official SDKs pass
 *           a short allowlist by default, and which popular clients pass more
 *           has not been measured yet.
 *   ACT 2 — through the MCP Rating gateway with default env scoping: the server
 *           only sees its allowlist (empty for an unknown server). PROTECTED.
 *
 * Fully reproducible, cross-platform, no Docker required.
 *
 * Run:  node demo/run-demo.mjs
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createGatewayServer } from "../dist/gateway-server.js";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const EVIL = join(__dirname, "evil-mcp-server.mjs");

// Plant a fake secret in this process's environment — the kind of thing that
// really sits in a developer's shell (cloud creds, API keys, DB URLs).
process.env.DEMO_SECRET_API_KEY = "sk-live-EXFILTRATED-do-not-leak-me";
process.env.DEMO_AWS_SECRET_ACCESS_KEY = "AKIA-FAKE-SUPER-SECRET";

const line = "─".repeat(64);

/**
 * Optional pacing for recordings.
 *
 * The whole demo runs in about 660ms, which is correct for a script and useless
 * for a GIF — 31 lines land at once and nobody can read the before/after that
 * is the entire point. `--pace` holds at each beat so a recording is watchable
 * without having to re-time frames in an editor afterwards.
 *
 *   node demo/run-demo.mjs            fast, unchanged, what CI and humans want
 *   node demo/run-demo.mjs --pace     ~10s, paced for screen capture
 */
const PACE_MS = process.argv.includes("--pace")
  ? Number(process.env.DEMO_PACE_MS || 2500)
  : 0;
const beat = (factor = 1) =>
  PACE_MS ? new Promise((r) => setTimeout(r, PACE_MS * factor)) : Promise.resolve();

async function act1RawSpawn() {
  console.log(`\n${line}\n  ACT 1 — Spawned with the whole environment (env: process.env)\n${line}`);
  const transport = new StdioClientTransport({
    command: "node",
    args: [EVIL],
    // StdioClientTransport defaults to a safe subset (HOME, PATH, USER…). A
    // client or script that passes `env: process.env` — the easy way to forward
    // the token a server needs — forwards everything. That is the case shown
    // here. It is not a claim about any particular client: which ones do this
    // hasn't been measured.
    env: { ...process.env },
  });
  const client = new Client({ name: "demo", version: "1.0.0" });
  await client.connect(transport);
  await beat(0.4);
  const res = await client.callTool({ name: "read_secrets", arguments: {} });
  console.log("\n  Result:\n" + indent(res.content[0].text));
  await client.close();
}

async function act2Gateway() {
  console.log(`\n${line}\n  ACT 2 — Through MCP Rating gateway (env scoping ON)\n${line}`);
  const ctx = createGatewayServer({
    registryApiUrl: "http://localhost:3000/api/v1",
    proxyTimeoutMs: 30_000, maxConnections: 5, logLevel: "error",
    permissionsPath: `${process.env.TEMP}/demo-perms.json`,
    configPath: `${process.env.TEMP}/demo-config.json`,
    profilesPath: `${process.env.TEMP}/demo-profiles.json`,
    registryCacheTtlMs: 60_000, reconnectMaxAttempts: 1,
    reconnectBaseDelayMs: 500, healthCheckIntervalMs: 60_000,
    enableAutoInstall: false, enableUsageTracking: false, enableAutoRecommend: false,
  });
  const cm = ctx.connectionManager;

  await cm.connect({ command: "node", args: [EVIL], confirmed: true });

  // The connected server's slug is derived from its command; grab it.
  const summary = cm.listConnections()[0];
  const conn = cm.getConnection(summary.slug);
  const manifest = conn?.manifest;
  console.log(
    `\n  Sandbox manifest: enforcement=${manifest?.enforcement}, env.allow=[${manifest?.env.allow.join(", ")}]`,
  );

  const res = await conn.client.callTool({ name: "read_secrets", arguments: {} });
  console.log("\n  Result:\n" + indent(res.content[0].text));
  await cm.disconnectAll();
}

function indent(s) {
  return s.split("\n").map((l) => "    " + l).join("\n");
}

console.log("\n💀 MCP Sandbox Demo — can a malicious server steal your secrets?");
// Every planted fake, not a hard-coded pair: render-gif.mjs plants more, and a
// header listing two above a result stealing four reads as a mistake.
const planted = Object.keys(process.env)
  .filter((k) => k.startsWith("DEMO_") && k !== "DEMO_PACE_MS")
  .sort();
console.log(`   Planted ${planted.length} fake secrets in the environment (DEMO_*)`);
await beat(0.8);

await act1RawSpawn();
await beat(1.4);   // hold on the leaked secrets — this is the frame that argues
await act2Gateway();
await beat(1.2);   // and on "nothing to steal"

console.log(`\n${line}`);
console.log("  Takeaway: same server, same secret. Passing the whole");
console.log("  environment leaks it; the gateway's env scoping withholds it.");
console.log("  The allowlist was empty because it's an unknown server.");
console.log(`${line}\n`);
process.exit(0);
