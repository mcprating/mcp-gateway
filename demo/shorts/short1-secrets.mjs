#!/usr/bin/env node
/**
 * Short 1 — "your MCP servers can read your API keys".
 *
 * The same argument as demo/run-demo.mjs, reframed for a 30-second vertical
 * video: narrower, slower, and with the two numbers that carry the point
 * (variables reachable, credentials taken) pulled out as the loudest thing on
 * screen.
 *
 *   node demo/shorts/short1-secrets.mjs
 *
 * SAFETY: this reads YOUR real environment — that is the whole point of Act 1 —
 * but evil-mcp-server.mjs prints only the count for real variables and shows
 * values solely for the DEMO_* pair planted below, which are fake by
 * construction. Nothing of yours reaches the recording. Do not "improve" that
 * redaction away to make the take more dramatic.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createGatewayServer } from "../../dist/gateway-server.js";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { beat, heading, ledger, rule, wrap, WIDTH } from "./_frame.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const EVIL = join(__dirname, "..", "evil-mcp-server.mjs");

// Fake credentials, planted so Act 1 has something safe to display in full.
process.env.DEMO_SECRET_API_KEY = "sk-live-EXFILTRATED";
process.env.DEMO_AWS_SECRET_ACCESS_KEY = "AKIA-FAKE-SECRET";

/**
 * Pull the two numbers that carry the argument out of the server's reply.
 *
 * evil-mcp-server.mjs formats its result for a landscape terminal — 79 columns,
 * plus one "<redacted — a real value…>" line per credential, which is both too
 * wide for a vertical frame and visually flat. We re-render it narrow instead.
 *
 * Deliberately fail-closed: if the wording there ever changes, this throws
 * rather than quietly rendering a zero. A wrong number in a published video is
 * not recoverable, and a crashed take is.
 */
function parseLeak(text) {
  const m = text.match(/EXFILTRATED (\d+) secret\(s\).*?all (\d+) variables/s);
  if (!m) {
    throw new Error(
      "Could not parse evil-mcp-server output — its wording changed.\n" +
        "Fix the regex in short1-secrets.mjs before recording:\n" +
        text,
    );
  }
  return { taken: Number(m[1]), total: Number(m[2]) };
}

function parseScoped(text) {
  const m = text.match(/can see (\d+) environment variable/);
  if (!m) {
    throw new Error("Could not parse sandboxed output — wording changed:\n" + text);
  }
  return Number(m[1]);
}

console.log(`\n${rule("━")}`);
console.log("  A MALICIOUS MCP SERVER");
console.log("  What can it actually reach?");
console.log(rule("━"));
console.log(wrap("Two fake credentials planted in this shell:"));
console.log("    DEMO_SECRET_API_KEY");
console.log("    DEMO_AWS_SECRET_ACCESS_KEY");
await beat(1.2);

// ── ACT 1 ────────────────────────────────────────────────────────────────────
heading("1. How every MCP client works today");
{
  const transport = new StdioClientTransport({
    command: "node",
    args: [EVIL],
    // Real clients routinely pass the whole environment so a server can find
    // the one token it needs. That forwards everything else with it.
    env: { ...process.env },
  });
  const client = new Client({ name: "short", version: "1.0.0" });
  await client.connect(transport);
  await beat(0.5);
  const res = await client.callTool({ name: "read_secrets", arguments: {} });
  const { taken, total } = parseLeak(res.content[0].text);
  await client.close();

  console.log(ledger("Server asked for:", "nothing"));
  console.log(ledger("Server received:", `ALL ${total} vars`));
  await beat(0.9);
  console.log(`\n  💀 It read ${taken} credentials, including:`);
  console.log("     DEMO_SECRET_API_KEY");
  console.log("       sk-live-EXFILTRATED");
  console.log("     DEMO_AWS_SECRET_ACCESS_KEY");
  console.log("       AKIA-FAKE-SECRET");
  // Real credentials are counted, never printed. The count is the alarming
  // part anyway — and it is the viewer's own shell it implicates, not mine.
  const real = taken - 2;
  if (real > 0) console.log(`     + ${real} real ones (hidden for this video)`);
}
await beat(1.6); // hold on the leak — this is the frame the video is built on

// ── ACT 2 ────────────────────────────────────────────────────────────────────
heading("2. The same server, through the gateway");
{
  const ctx = createGatewayServer({
    registryApiUrl: "https://mcprating.io/api/v1",
    proxyTimeoutMs: 30_000,
    maxConnections: 5,
    logLevel: "error",
    permissionsPath: join(__dirname, ".short-perms.json"),
    configPath: join(__dirname, ".short-config.json"),
    profilesPath: join(__dirname, ".short-profiles.json"),
    registryCacheTtlMs: 60_000,
    reconnectMaxAttempts: 1,
    reconnectBaseDelayMs: 500,
    healthCheckIntervalMs: 60_000,
    enableAutoInstall: false,
    enableUsageTracking: false,
    enableAutoRecommend: false,
  });
  const cm = ctx.connectionManager;
  await cm.connect({ command: "node", args: [EVIL], confirmed: true });

  const conn = cm.getConnection(cm.listConnections()[0].slug);
  const allow = conn?.manifest?.env.allow ?? [];
  console.log(wrap(`Allowlist for an unknown server: ${allow.length === 0 ? "(empty)" : allow.join(", ")}`));
  await beat(0.6);

  const res = await conn.client.callTool({ name: "read_secrets", arguments: {} });
  const visible = parseScoped(res.content[0].text);
  await cm.disconnectAll();

  console.log(ledger("Server asked for:", "nothing"));
  console.log(ledger("Server received:", `${visible} vars`));
  await beat(0.9);
  console.log("\n  🛡️  It read 0 credentials.");
  console.log(wrap("Nothing sensitive was there to take.", "     "));
}
await beat(1.6);

console.log(`\n${rule("━")}`);
console.log("  Same server. Same shell.");
console.log("  One of them got your keys.");
console.log(rule("━"));
console.log("  github.com/mcprating/mcp-gateway".padStart(Math.floor((WIDTH + 32) / 2)));
console.log();
process.exit(0);
