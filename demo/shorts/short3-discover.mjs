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
// The query must describe the server we go on to connect to. It was "postgres",
// which listed three Postgres servers and then connected to a DuckDuckGo search
// server — incoherent to anyone actually watching, and the kind of detail that
// costs more credibility than the demo earns. "web search" was no better: sorted
// by quality that returns Google Workspace servers.
const QUERY = process.env.SHORT3_QUERY || "duckduckgo";
// The TOP-RANKED result for that query, and it starts unattended with no
// credentials — so the demo connects to the best server it just listed rather
// than to some fourth one off screen. Swap via SHORT3_SLUG if it stops
// publishing; check the replacement is still in the first three.
const SLUG = process.env.SHORT3_SLUG || "zhafron-mcp-web-search";

console.log(`\n${rule("━")}`);
console.log("  ONE MCP SERVER, OR ALL OF THEM");
console.log(rule("━"));
// Two lines, not three. Adding the cache caveat and a second tool to the connect
// output pushed the closing URL 56px off the bottom of the frame.
console.log(wrap("Every server in your config is spawned at launch, and costs context every turn."));
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
// Say it is cached. On a warm npx cache this reads ~2s, and our own published
// measurement puts the median server at 13.2s to a usable tool list. Showing
// the fast number without the caveat would be contradicted by our own blog.
console.log("     (npx cached — first run is slower)");
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
// One closing line, not two. The install command was competing with the URL for
// the last frame and pushing it off the bottom; the description carries the
// command, and a Short only ever needs one thing to remember.
console.log("  github.com/mcprating/mcp-gateway");
console.log();

await ctx.connectionManager.disconnectAll();
process.exit(0);
