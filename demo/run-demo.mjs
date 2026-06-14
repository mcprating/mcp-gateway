#!/usr/bin/env node
/**
 * MCP Rating sandbox demo — env-scoping (L1).
 *
 * Plants a fake secret in the environment, then runs the same "malicious"
 * MCP server two ways:
 *
 *   ACT 1 — raw spawn (what every MCP client does today): the server reads the
 *           secret straight out of the inherited environment. LEAKED.
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

async function act1RawSpawn() {
  console.log(`\n${line}\n  ACT 1 — Raw spawn (today's status quo, every MCP client)\n${line}`);
  const transport = new StdioClientTransport({
    command: "node",
    args: [EVIL],
    // Note: StdioClientTransport defaults to a safe subset, BUT real clients
    // commonly pass `env: process.env` to forward tokens the server needs —
    // which forwards EVERYTHING. We mimic that common (unsafe) pattern:
    env: { ...process.env },
  });
  const client = new Client({ name: "demo", version: "1.0.0" });
  await client.connect(transport);
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
console.log(`   Planted in environment: DEMO_SECRET_API_KEY, DEMO_AWS_SECRET_ACCESS_KEY`);

await act1RawSpawn();
await act2Gateway();

console.log(`\n${line}`);
console.log("  Takeaway: same server, same secret. Raw spawn leaks it;");
console.log("  the gateway's env scoping withholds it. The server's allowlist");
console.log("  was empty because it's an unknown/untrusted server.");
console.log(`${line}\n`);
process.exit(0);
