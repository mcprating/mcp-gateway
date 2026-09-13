#!/usr/bin/env node
/**
 * Short 3 — "one config entry instead of fifty".
 *
 *   node demo/shorts/short3-discover.mjs
 *
 * Everything here is live: the search hits the public registry, and the connect
 * really spawns the server and lists its tools.
 *
 * ON THE CONNECT TIME: it is printed, not hidden. Our own measurements put the
 * median MCP server at ~13s to a usable tool list, so a video claiming "installs
 * in 10 seconds" would be contradicted by our own blog post. Showing the real
 * number turns it into the argument instead — the gateway pays that cost once,
 * when you ask for a server, rather than paying it for every configured server
 * at every client launch.
 */
import { createGatewayServer } from "../../dist/gateway-server.js";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { beat, fmt, heading, ledger, rule, wrap } from "./_frame.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const API = "https://mcprating.io/api/v1";
const QUERY = process.env.SHORT3_QUERY || "postgres";
// No credentials, one tool, starts unattended — so a take never dies waiting on
// an auth prompt. Swap via SHORT3_SLUG if this one ever stops publishing.
const SLUG = process.env.SHORT3_SLUG || "oevortex-ddg-search";

console.log(`\n${rule("━")}`);
console.log("  ONE MCP SERVER, OR ALL OF THEM");
console.log(rule("━"));
console.log(wrap("Every server in your client config is spawned at launch and costs context every turn — used or not."));
await beat(1.6);

heading("Replace the whole config with this");
console.log('  { "mcpServers": { "gateway": {');
console.log('      "command": "npx",');
console.log('      "args": ["-y",');
console.log('               "@mcp-rating/gateway"] } } }');
await beat(2);

// ── Discover ─────────────────────────────────────────────────────────────────
heading(`Then ask:  mcp_discover("${QUERY}")`);
// `sortBy`, not `sort` — the API ignores unknown params silently, and without
// this the three results came back in default order while the screen claimed
// they were quality-ranked. A caption that does not match the numbers under it
// is the one thing this project cannot afford to publish.
const found = await fetch(
  `${API}/servers?limit=3&sortBy=quality&search=${encodeURIComponent(QUERY)}`,
).then((r) => r.json());
console.log(wrap(`${fmt(found.total)} matches. Best three by quality score:`));
for (const s of found.data) {
  const name = s.slug.length > 26 ? s.slug.slice(0, 25) + "…" : s.slug;
  console.log(ledger(name, `${s.qualityScore}/100`));
}
await beat(2.2);

// ── Connect ──────────────────────────────────────────────────────────────────
heading("Connect one, on demand");
console.log(`  > mcp_connect("${SLUG}")`);
const ctx = createGatewayServer({
  registryApiUrl: API,
  proxyTimeoutMs: 60_000,
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

const started = Date.now();
await ctx.connectionManager.connect({ slug: SLUG, confirmed: true });
const seconds = ((Date.now() - started) / 1000).toFixed(1);

const summary = ctx.connectionManager.listConnections()[0];
const conn = ctx.connectionManager.getConnection(summary.slug);
const { tools } = await conn.client.listTools();

console.log(ledger("connected in", `${seconds}s`));
console.log(ledger("tools now available", tools.length));
for (const t of tools.slice(0, 4)) console.log(`    ${t.name}`);
await beat(1.8);

console.log(`\n${rule("━")}`);
// Kept to two lines that each fit in 44 columns unwrapped: the first phrasing
// broke as "…when you ask for a / server —", stranding one word on its own line,
// and the extra row pushed the closing frame 6px past the bottom of a 1080x1920
// render.
console.log(wrap("Paid once, when you ask for a server."));
console.log(wrap("Not by every server, at every launch."));
console.log(rule("━"));
console.log("  npx -y @mcp-rating/gateway");
console.log("  github.com/mcprating/mcp-gateway");
console.log();

await ctx.connectionManager.disconnectAll();
process.exit(0);
